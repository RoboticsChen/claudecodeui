import fs, { type FSWatcher } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { listLiveClaudeCliProcesses, sessionSynchronizerService } from '@/modules/providers/index.js';
import type { chatRunRegistry } from '@/modules/websocket/index.js';
import {
  clearTmuxPaneInput,
  listTmuxPanes,
  resolveTmuxPaneForPid,
  sendEscapeToTmuxPane,
  submitTextToTmuxPane,
} from '@/modules/external-sessions/services/tmux.service.js';
import type { LiveClaudeCliProcess, RealtimeClientConnection } from '@/shared/types.js';
import { createNormalizedMessage } from '@/shared/utils.js';

type ChatRunRegistry = typeof chatRunRegistry;
type ChatRun = NonNullable<ReturnType<ChatRunRegistry['startRun']>>;

/**
 * What the monitor needs from the websocket module. Passed in by the server
 * composition root rather than imported, because the websocket module's chat
 * gateway imports this module and a direct import back would be a cycle.
 */
type ExternalSessionMonitorDependencies = {
  runRegistry: ChatRunRegistry;
  /** Every open chat socket; an external run streams to all of them. */
  connections: Iterable<RealtimeClientConnection>;
  /** Sends one serialized frame to every connected client. */
  broadcast: (payload: string) => void;
  /** Announces a session the monitor just indexed so sidebars list it. */
  announceSession: (sessionId: string) => Promise<void>;
};

/**
 * One terminal Claude session the web chat is attached to.
 *
 * Keyed by app session id. `pid` and `providerSessionId` are both part of
 * the identity: a `/clear` keeps the process but starts a new provider
 * session (a new transcript), and a restarted CLI resumes the same provider
 * session in a new process — either way the attachment is rebuilt.
 */
type Attachment = {
  appSessionId: string;
  providerSessionId: string;
  pid: number;
  paneId: string;
  status: LiveClaudeCliProcess['status'];
  transcriptPath: string | null;
  transcriptWatcher: FSWatcher | null;
  transcriptDebounce: ReturnType<typeof setTimeout> | null;
  /**
   * Until when a `busy` registry status is ignored after an interrupt. The
   * CLI rewrites its registry entry a moment after Escape, and a scan in
   * that gap would start a new run for the turn that was just stopped.
   */
  ignoreBusyUntil: number;
};

/** Fallback scan cadence; registry-directory events trigger scans sooner. */
const SCAN_INTERVAL_MS = 2_000;
/** Coalesces the burst of registry writes one status change produces. */
const REGISTRY_EVENT_DEBOUNCE_MS = 50;
/**
 * Coalesces the rows Claude appends for one step (an assistant row, its tool
 * call, the tool result) into one history refresh on the client.
 */
const TRANSCRIPT_EVENT_DEBOUNCE_MS = 200;
/**
 * A run started by a web send is kept at least this long even if the CLI
 * still reads idle: the registry flips to busy a moment after the paste is
 * submitted, and ending the run in that gap would flash the composer idle.
 */
const SEND_GRACE_MS = 3_000;
/** How long a stale `busy` is ignored after an interrupt (see `ignoreBusyUntil`). */
const INTERRUPT_GRACE_MS = 3_000;
/** How often an unindexed CLI session is looked for on disk again. */
const INDEX_RETRY_MS = 5_000;

const registryDirectory = () => path.join(os.homedir(), '.claude', 'sessions');
const projectsDirectory = () => path.join(os.homedir(), '.claude', 'projects');

let dependencies: ExternalSessionMonitorDependencies | null = null;
const attachments = new Map<string, Attachment>();
/** Runs this module started, by app session id; never an SDK-driven run. */
const externalRuns = new Map<string, { run: ChatRun; startedAt: number }>();
/** `pid → paneId` once resolved; a pid never moves to another pane. */
const paneByPid = new Map<number, string>();
const lastIndexAttemptAt = new Map<string, number>();

let scanTimer: ReturnType<typeof setInterval> | null = null;
let registryWatcher: FSWatcher | null = null;
let registryDebounce: ReturnType<typeof setTimeout> | null = null;
let scanInFlight: Promise<void> | null = null;
let scanAgain = false;

function sendStatus(run: ChatRun, providerSessionId: string): void {
  run.writer.send(createNormalizedMessage({
    kind: 'status',
    text: 'Working in terminal',
    canInterrupt: true,
    sessionId: providerSessionId,
    provider: 'claude',
  }));
}

/**
 * Starts the run the web chat shows while the terminal works on a turn.
 *
 * Every connected socket is added to the run's audience: a turn typed in the
 * terminal starts without any client having asked for it, so nobody would be
 * subscribed yet. Clients filter frames by session id themselves.
 */
function startExternalRun(attachment: Attachment): void {
  if (!dependencies) {
    return;
  }

  const current = dependencies.runRegistry.getRun(attachment.appSessionId);
  if (current?.status === 'running') {
    // Either ours already, or a run CloudCLI itself drives through the SDK,
    // which this module must never end.
    return;
  }

  const run = dependencies.runRegistry.startRun({
    appSessionId: attachment.appSessionId,
    provider: 'claude',
    providerSessionId: attachment.providerSessionId,
    connection: null,
    userId: null,
  });
  if (!run) {
    return;
  }

  for (const connection of dependencies.connections) {
    run.writer.updateWebSocket(connection);
  }
  externalRuns.set(attachment.appSessionId, { run, startedAt: Date.now() });
  sendStatus(run, attachment.providerSessionId);
}

function completeExternalRun(appSessionId: string, opts: { exitCode: number; aborted?: boolean }): void {
  const entry = externalRuns.get(appSessionId);
  if (!entry || !dependencies) {
    return;
  }
  externalRuns.delete(appSessionId);
  dependencies.runRegistry.completeRunIfCurrent(entry.run, opts);
}

/** Starts or ends the external run so it follows the CLI's own turn state. */
function reconcileRun(attachment: Attachment): void {
  if (attachment.status === 'busy') {
    if (Date.now() >= attachment.ignoreBusyUntil) {
      startExternalRun(attachment);
    }
    return;
  }

  const entry = externalRuns.get(attachment.appSessionId);
  if (entry && Date.now() - entry.startedAt >= SEND_GRACE_MS) {
    completeExternalRun(attachment.appSessionId, { exitCode: 0 });
  }
}

function broadcastTranscriptChanged(appSessionId: string): void {
  dependencies?.broadcast(JSON.stringify({
    kind: 'transcript_changed',
    sessionId: appSessionId,
    provider: 'claude',
    timestamp: new Date().toISOString(),
  }));
}

/**
 * Watches an attachment's transcript. Retried on every scan until it works:
 * a brand-new CLI session has no transcript file until its first message.
 */
function ensureTranscriptWatcher(attachment: Attachment): void {
  if (attachment.transcriptWatcher || !attachment.transcriptPath) {
    return;
  }

  try {
    attachment.transcriptWatcher = fs.watch(attachment.transcriptPath, () => {
      if (attachment.transcriptDebounce) {
        clearTimeout(attachment.transcriptDebounce);
      }
      attachment.transcriptDebounce = setTimeout(() => {
        attachment.transcriptDebounce = null;
        broadcastTranscriptChanged(attachment.appSessionId);
      }, TRANSCRIPT_EVENT_DEBOUNCE_MS);
    });
    attachment.transcriptWatcher.on('error', () => {
      attachment.transcriptWatcher?.close();
      attachment.transcriptWatcher = null;
    });
  } catch {
    attachment.transcriptWatcher = null;
  }
}

function detach(attachment: Attachment): void {
  attachment.transcriptWatcher?.close();
  attachment.transcriptWatcher = null;
  if (attachment.transcriptDebounce) {
    clearTimeout(attachment.transcriptDebounce);
  }
  attachments.delete(attachment.appSessionId);
  completeExternalRun(attachment.appSessionId, { exitCode: 0 });
}

/**
 * Finds `<providerSessionId>.jsonl` under any project directory. The
 * directory name is not reliably derivable from the cwd, so it is searched.
 */
async function findTranscriptPath(providerSessionId: string): Promise<string | null> {
  let projectDirs: string[];
  try {
    projectDirs = await fsp.readdir(projectsDirectory());
  } catch {
    return null;
  }

  for (const projectDir of projectDirs) {
    const candidate = path.join(projectsDirectory(), projectDir, `${providerSessionId}.jsonl`);
    try {
      await fsp.access(candidate);
      return candidate;
    } catch {
      // Not in this project.
    }
  }
  return null;
}

/**
 * Indexes a CLI session the session watcher has not picked up yet, so a
 * conversation started in the terminal is attachable within a scan instead of
 * after the watcher's next poll.
 */
async function indexCliSession(providerSessionId: string): Promise<void> {
  const now = Date.now();
  if (now - (lastIndexAttemptAt.get(providerSessionId) ?? 0) < INDEX_RETRY_MS) {
    return;
  }
  lastIndexAttemptAt.set(providerSessionId, now);

  const transcriptPath = await findTranscriptPath(providerSessionId);
  if (!transcriptPath) {
    return;
  }

  const result = await sessionSynchronizerService.synchronizeProviderFile('claude', transcriptPath);
  if (result.indexed && result.sessionId) {
    await dependencies?.announceSession(result.sessionId);
  }
}

async function resolvePane(pid: number, panes: Map<number, string>): Promise<string | null> {
  const cached = paneByPid.get(pid);
  if (cached && [...panes.values()].includes(cached)) {
    return cached;
  }

  const paneId = await resolveTmuxPaneForPid(pid, panes);
  if (paneId) {
    paneByPid.set(pid, paneId);
  }
  return paneId;
}

async function scanOnce(): Promise<void> {
  const [processes, panes] = await Promise.all([listLiveClaudeCliProcesses(), listTmuxPanes()]);
  const seen = new Set<string>();

  for (const cliProcess of processes) {
    const paneId = panes.size > 0 ? await resolvePane(cliProcess.pid, panes) : null;
    if (!paneId) {
      continue;
    }

    let session = sessionsDb.getSessionByProviderSessionId(cliProcess.providerSessionId);
    if (!session) {
      await indexCliSession(cliProcess.providerSessionId);
      session = sessionsDb.getSessionByProviderSessionId(cliProcess.providerSessionId);
    }
    if (!session || session.provider !== 'claude') {
      continue;
    }

    const appSessionId = session.session_id;
    seen.add(appSessionId);

    let attachment = attachments.get(appSessionId);
    if (attachment && (attachment.pid !== cliProcess.pid || attachment.providerSessionId !== cliProcess.providerSessionId)) {
      detach(attachment);
      attachment = undefined;
    }
    if (!attachment) {
      attachment = {
        appSessionId,
        providerSessionId: cliProcess.providerSessionId,
        pid: cliProcess.pid,
        paneId,
        status: cliProcess.status,
        transcriptPath: session.jsonl_path,
        transcriptWatcher: null,
        transcriptDebounce: null,
        ignoreBusyUntil: 0,
      };
      attachments.set(appSessionId, attachment);
    }

    attachment.paneId = paneId;
    attachment.status = cliProcess.status;
    attachment.transcriptPath = session.jsonl_path ?? attachment.transcriptPath;
    ensureTranscriptWatcher(attachment);
    reconcileRun(attachment);
  }

  for (const attachment of [...attachments.values()]) {
    if (!seen.has(attachment.appSessionId)) {
      detach(attachment);
    }
  }

  for (const pid of paneByPid.keys()) {
    if (!processes.some((cliProcess) => cliProcess.pid === pid)) {
      paneByPid.delete(pid);
    }
  }
}

/**
 * Runs one scan, or joins the one in flight. A request that arrives during a
 * scan schedules exactly one more, so a registry change is never missed.
 */
function scan(): Promise<void> {
  if (scanInFlight) {
    scanAgain = true;
    return scanInFlight;
  }

  scanInFlight = scanOnce()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ExternalSessions] scan failed', { error: message });
    })
    .finally(() => {
      scanInFlight = null;
      if (scanAgain) {
        scanAgain = false;
        void scan();
      }
    });
  return scanInFlight;
}

async function findAttachment(appSessionId: string): Promise<Attachment | null> {
  if (!dependencies) {
    return null;
  }
  // A session attached since the last scan (just started in tmux) is found by
  // scanning now rather than refusing the send.
  if (!attachments.has(appSessionId)) {
    await scan();
  }
  return attachments.get(appSessionId) ?? null;
}

/**
 * Starts watching terminal Claude sessions. Idempotent.
 *
 * Used by the server composition root at startup, which hands over the
 * websocket pieces the monitor drives (see `ExternalSessionMonitorDependencies`).
 */
export function startExternalSessionMonitor(deps: ExternalSessionMonitorDependencies): void {
  if (dependencies) {
    return;
  }
  dependencies = deps;

  void scan();
  scanTimer = setInterval(() => void scan(), SCAN_INTERVAL_MS);
  scanTimer.unref?.();

  try {
    registryWatcher = fs.watch(registryDirectory(), () => {
      if (registryDebounce) {
        clearTimeout(registryDebounce);
      }
      registryDebounce = setTimeout(() => {
        registryDebounce = null;
        void scan();
      }, REGISTRY_EVENT_DEBOUNCE_MS);
    });
    registryWatcher.on('error', () => {
      registryWatcher?.close();
      registryWatcher = null;
    });
  } catch {
    // No registry directory yet: the interval scan still covers it.
    registryWatcher = null;
  }
}

/**
 * Stops the monitor and releases every watcher. Runs it leaves are ended so
 * no client stays "processing" for a terminal nobody watches anymore.
 *
 * Used by the server composition root on shutdown, and by tests.
 */
export function stopExternalSessionMonitor(): void {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  if (registryDebounce) {
    clearTimeout(registryDebounce);
    registryDebounce = null;
  }
  registryWatcher?.close();
  registryWatcher = null;
  for (const attachment of [...attachments.values()]) {
    detach(attachment);
  }
  paneByPid.clear();
  lastIndexAttemptAt.clear();
  dependencies = null;
}

/**
 * Whether an app session is currently a live terminal session the web chat
 * types into instead of starting its own Claude process.
 *
 * Used by the websocket module's chat gateway to route sends, steers and
 * stops for that session here.
 */
export async function isExternalSession(appSessionId: string): Promise<boolean> {
  return (await findAttachment(appSessionId)) !== null;
}

/**
 * Types a message from the web chat into the session's terminal and submits
 * it. A turn already running in the terminal simply queues it, the same as
 * typing ahead at the keyboard.
 *
 * Used by the websocket module's chat gateway for `chat.send`, `chat.steer`
 * and queued/scheduled turns. Returns an error message, or null on success.
 */
export async function sendToExternalSession(appSessionId: string, text: string): Promise<string | null> {
  const attachment = await findAttachment(appSessionId);
  if (!attachment) {
    return 'The terminal session is no longer running.';
  }

  try {
    await submitTextToTmuxPane(attachment.paneId, text);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  // Show the turn as running at once; the registry catches up within a scan.
  // A send is a new turn, so it ends any post-interrupt grace.
  attachment.status = 'busy';
  attachment.ignoreBusyUntil = 0;
  startExternalRun(attachment);
  return null;
}

/**
 * Interrupts the terminal's running turn (Escape) and ends the web run.
 *
 * Used by the websocket module's chat gateway for `chat.abort`.
 */
export async function interruptExternalSession(appSessionId: string): Promise<boolean> {
  const attachment = await findAttachment(appSessionId);
  if (!attachment) {
    return false;
  }

  try {
    await sendEscapeToTmuxPane(attachment.paneId);
  } catch {
    return false;
  }
  // Ended as aborted right away: the CLI turns idle within milliseconds of
  // Escape, and a scan in the wait below would otherwise end the run first
  // as an ordinary completion.
  attachment.ignoreBusyUntil = Date.now() + INTERRUPT_GRACE_MS;
  completeExternalRun(appSessionId, { exitCode: 0, aborted: true });

  try {
    // The TUI puts the interrupted message back into its input box; clear it
    // so the next web message is not submitted together with it. Escape is
    // given a moment to land first, or the clear races the restore.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await clearTmuxPaneInput(attachment.paneId);
  } catch {
    // The turn is already stopped; a leftover draft is only cosmetic.
  }
  return true;
}

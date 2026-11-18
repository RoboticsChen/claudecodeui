import fs, { type FSWatcher } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { listLiveClaudeCliProcesses, sessionSynchronizerService } from '@/modules/providers/index.js';
import type { chatRunRegistry } from '@/modules/websocket/index.js';
import {
  buildAttachedTmuxSessionCommand,
  captureTmuxPane,
  clearTmuxPaneInput,
  createDetachedTmuxSession,
  hasTmuxSession,
  isTmuxInstalled,
  killTmuxPane,
  listTmuxPanes,
  quoteShellArgument,
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
/** How long a Claude CLI started for the web chat may take to show its input box. */
const SPAWN_READY_TIMEOUT_MS = 45_000;
const SPAWN_POLL_MS = 300;
/** How long a suspend waits for the Claude CLI to exit after its pane is closed. */
const SUSPEND_EXIT_TIMEOUT_MS = 5_000;
/**
 * Flags every Claude CLI this module starts gets. The web chat cannot answer
 * a permission prompt in the terminal, so the default skips them; set
 * `CLOUDCLI_TERMINAL_CLAUDE_FLAGS` (shell syntax) to override.
 */
const DEFAULT_TERMINAL_CLAUDE_FLAGS = '--permission-mode bypassPermissions';
/**
 * Prompts a terminal can show that a pasted message must never land in: the
 * TUI would take the text as the answer. Sends are refused while one shows.
 */
const BLOCKING_PROMPT_PATTERN = /trust this folder|Do you trust|Do you want to proceed\?|Resume from summary/i;
const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const registryDirectory = () => path.join(os.homedir(), '.claude', 'sessions');
const projectsDirectory = () => path.join(os.homedir(), '.claude', 'projects');

let dependencies: ExternalSessionMonitorDependencies | null = null;
const attachments = new Map<string, Attachment>();
/** Runs this module started, by app session id; never an SDK-driven run. */
const externalRuns = new Map<string, { run: ChatRun; startedAt: number }>();
/** `pid → paneId` once resolved; a pid never moves to another pane. */
const paneByPid = new Map<number, string>();
const lastIndexAttemptAt = new Map<string, number>();
/** Every live CLI process the last scan saw, tmux or not. */
let lastLiveProcesses: LiveClaudeCliProcess[] = [];
/**
 * Sessions whose terminal this module is starting, by app session id. While
 * one is pending its run is kept open (the CLI reads idle until the message
 * is typed in), and a second send for it waits for the same start.
 */
const pendingStarts = new Map<string, Promise<string | null>>();

let scanTimer: ReturnType<typeof setInterval> | null = null;
let registryWatcher: FSWatcher | null = null;
let registryDebounce: ReturnType<typeof setTimeout> | null = null;
let scanInFlight: Promise<void> | null = null;
let scanAgain = false;

/**
 * Starts the run the web chat shows while the terminal works on a turn, or
 * while a terminal for the session is still starting.
 *
 * Every connected socket is added to the run's audience: a turn typed in the
 * terminal starts without any client having asked for it, so nobody would be
 * subscribed yet. Clients filter frames by session id themselves.
 */
function startExternalRun(
  appSessionId: string,
  providerSessionId: string | null,
  status: { text: string; canInterrupt: boolean } = { text: 'Working in terminal', canInterrupt: true },
): void {
  // Already running: either ours, or a run CloudCLI itself drives through the
  // SDK, which this module must never end.
  if (!dependencies || dependencies.runRegistry.getRun(appSessionId)?.status === 'running') {
    return;
  }

  const run = dependencies.runRegistry.startRun({
    appSessionId,
    provider: 'claude',
    providerSessionId,
    connection: null,
    userId: null,
  });
  if (!run) {
    return;
  }

  for (const connection of dependencies.connections) {
    run.writer.updateWebSocket(connection);
  }
  externalRuns.set(appSessionId, { run, startedAt: Date.now() });
  run.writer.send(createNormalizedMessage({
    kind: 'status',
    ...status,
    sessionId: providerSessionId ?? appSessionId,
    provider: 'claude',
  }));
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
      startExternalRun(attachment.appSessionId, attachment.providerSessionId);
    }
    return;
  }

  const entry = externalRuns.get(attachment.appSessionId);
  if (entry && !pendingStarts.has(attachment.appSessionId) && Date.now() - entry.startedAt >= SEND_GRACE_MS) {
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

/**
 * Orders live processes so that, when several CLIs run one provider session
 * (a copy resumed by hand in another tmux window), the one the web chat
 * should drive comes first: a busy one, then the most recently started.
 * The scan attaches the first it sees per session, so without this order it
 * would flip between them on every scan.
 */
function preferredProcessOrder(processes: LiveClaudeCliProcess[]): LiveClaudeCliProcess[] {
  return [...processes].sort((left, right) => {
    if (left.status !== right.status) {
      return left.status === 'busy' ? -1 : 1;
    }
    return right.startedAt - left.startedAt;
  });
}

async function scanOnce(): Promise<void> {
  const [processes, panes] = await Promise.all([listLiveClaudeCliProcesses(), listTmuxPanes()]);
  lastLiveProcesses = processes;
  const seen = new Set<string>();

  for (const cliProcess of preferredProcessOrder(processes)) {
    const paneId = panes.size > 0 ? await resolvePane(cliProcess.pid, panes) : null;
    if (!paneId) {
      continue;
    }

    let session = sessionsDb.getSessionByProviderSessionId(cliProcess.providerSessionId);
    if (!session?.jsonl_path) {
      // Not indexed yet, or a session the web chat started, which has no
      // transcript on record until the CLI writes its first row; the history
      // reader and the live refresh both need the path, so it is looked for
      // now instead of at the watcher's next poll.
      await indexCliSession(cliProcess.providerSessionId);
      session = sessionsDb.getSessionByProviderSessionId(cliProcess.providerSessionId);
    }
    if (!session || session.provider !== 'claude') {
      continue;
    }

    const appSessionId = session.session_id;
    if (seen.has(appSessionId)) {
      // A second CLI on the same session; the preferred one is already attached.
      continue;
    }
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
 * Whether the Claude TUI in a pane shows its input box: a line that starts
 * with `❯` at column 0 right under a rule. Dialogs (folder trust, permission
 * prompts) draw their `❯` indented, so they do not count.
 */
function paneShowsInputBox(text: string): boolean {
  const lines = text.split('\n');
  // The TUI follows `❯` with a no-break space (U+00A0), so `\s` rather than ' '.
  return lines.some((line, index) => /^❯(\s|$)/u.test(line) && index > 0 && /^─{10,}/.test(lines[index - 1] ?? ''));
}

/** The absolute path of `claude` on this server's PATH, so the pane does not depend on the tmux server's. */
async function resolveClaudeBinary(): Promise<string | null> {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, 'claude');
    try {
      await fsp.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

/** `cc-<folder>` like the `ccode` shell function, with a number when taken. */
async function pickTmuxSessionName(cwd: string): Promise<string> {
  const base = `cc-${path.basename(cwd).replace(/[^A-Za-z0-9_-]/g, '_') || 'session'}`;
  let name = base;
  for (let suffix = 2; await hasTmuxSession(name); suffix += 1) {
    name = `${base}-${suffix}`;
  }
  return name;
}

/**
 * A live Claude CLI process for this provider session that is not in tmux,
 * so the web chat cannot type into it. Starting a second CLI on the same
 * session would fork the conversation, which is exactly what this module
 * exists to prevent.
 */
function findUnattachableProcess(providerSessionId: string): LiveClaudeCliProcess | null {
  return lastLiveProcesses.find((entry) => entry.providerSessionId === providerSessionId) ?? null;
}

function describeUnattachableProcess(cliProcess: LiveClaudeCliProcess): string {
  return `This conversation is already open in a Claude CLI outside tmux (pid ${cliProcess.pid}). `
    + 'Continue it there, or close it so the web chat can open it in a tmux terminal.';
}

/**
 * The provider session id the terminal resumes, or a new one for a session
 * that has never run. A new id is recorded on the session row before the CLI
 * starts, so the row and the transcript the CLI writes agree from its first
 * line on.
 */
async function resolveTerminalSessionTarget(
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>,
): Promise<{ providerSessionId: string; resume: boolean } | string> {
  const existing = session.provider_session_id;
  if (existing) {
    if (!SAFE_SESSION_ID_PATTERN.test(existing)) {
      return `Session id "${existing}" cannot be passed to the Claude CLI.`;
    }
    const transcript = session.jsonl_path ?? await findTranscriptPath(existing);
    return { providerSessionId: existing, resume: Boolean(transcript) };
  }

  // App ids are UUIDs, which is what `--session-id` takes; reusing it keeps
  // the app id and the provider id the same.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.session_id)) {
    return `Session id "${session.session_id}" is not a UUID the Claude CLI can take.`;
  }
  sessionsDb.assignProviderSessionId(session.session_id, session.session_id);
  return { providerSessionId: session.session_id, resume: false };
}

/** The shell command a pane runs to start the Claude CLI for a session. */
function buildClaudeCommand(claudeBinary: string, target: { providerSessionId: string; resume: boolean }, model?: string): string {
  const flags = process.env.CLOUDCLI_TERMINAL_CLAUDE_FLAGS ?? DEFAULT_TERMINAL_CLAUDE_FLAGS;
  const modelFlag = model && model !== 'default' && /^[A-Za-z0-9._[\]-]+$/.test(model) ? ` --model ${quoteShellArgument(model)}` : '';
  const sessionFlag = target.resume
    ? `--resume ${quoteShellArgument(target.providerSessionId)}`
    : `--session-id ${quoteShellArgument(target.providerSessionId)}`;
  return `exec ${quoteShellArgument(claudeBinary)} ${flags}${modelFlag} ${sessionFlag}`;
}

/**
 * Waits until the CLI started in `paneId` is registered for the session and
 * shows its input box. Returns an error message, or null once it is ready.
 */
async function waitForTerminalReady(paneId: string, panePid: number, providerSessionId: string, tmuxName: string): Promise<string | null> {
  const deadline = Date.now() + SPAWN_READY_TIMEOUT_MS;
  let lastText = '';
  while (Date.now() < deadline) {
    const text = await captureTmuxPane(paneId);
    if (text === null) {
      const tail = lastText.trim().split('\n').slice(-3).join(' ').trim();
      return `Claude exited before it was ready${tail ? `: ${tail}` : '.'}`;
    }
    lastText = text;

    if (BLOCKING_PROMPT_PATTERN.test(text)) {
      return `Claude is asking a question in the terminal before it can start. Answer it with \`tmux attach -t ${tmuxName}\`, then send again.`;
    }

    const processes = await listLiveClaudeCliProcesses();
    const registered = processes.some((entry) => entry.providerSessionId === providerSessionId && entry.pid === panePid);
    if (registered && paneShowsInputBox(text)) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, SPAWN_POLL_MS));
  }
  return `Claude did not become ready in the terminal within ${SPAWN_READY_TIMEOUT_MS / 1000}s. Check it with \`tmux attach -t ${tmuxName}\`.`;
}

async function startTerminalForSession(appSessionId: string, model?: string): Promise<string | null> {
  const session = sessionsDb.getSessionById(appSessionId);
  if (!session || session.provider !== 'claude') {
    return 'The session no longer exists.';
  }

  const cwd = session.project_path;
  try {
    if (!cwd || !(await fsp.stat(cwd)).isDirectory()) {
      return `The project folder ${cwd ?? ''} does not exist.`;
    }
  } catch {
    return `The project folder ${cwd} does not exist.`;
  }

  const target = await resolveTerminalSessionTarget(session);
  if (typeof target === 'string') {
    return target;
  }

  const unattachable = findUnattachableProcess(target.providerSessionId);
  if (unattachable) {
    return describeUnattachableProcess(unattachable);
  }

  const claudeBinary = await resolveClaudeBinary();
  if (!claudeBinary) {
    return 'The Claude CLI was not found on the server\'s PATH.';
  }

  // Held open while the terminal starts, so the composer shows it as working.
  startExternalRun(appSessionId, target.providerSessionId, { text: 'Starting Claude in a terminal', canInterrupt: false });
  const tmuxName = await pickTmuxSessionName(cwd);
  let pane: { paneId: string; panePid: number };
  try {
    pane = await createDetachedTmuxSession({ name: tmuxName, cwd, command: buildClaudeCommand(claudeBinary, target, model) });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  console.log('[ExternalSessions] started Claude in tmux', { appSessionId, tmuxName, pane: pane.paneId, resume: target.resume });
  const notReady = await waitForTerminalReady(pane.paneId, pane.panePid, target.providerSessionId, tmuxName);
  if (notReady) {
    return notReady;
  }
  await scan();
  return attachments.has(appSessionId) ? null : 'The terminal started but could not be attached.';
}

/**
 * Makes sure the session runs in a tmux terminal the web chat can type into,
 * starting one when no CLI runs it. Returns an error message, or null when
 * the session is attached.
 *
 * Concurrent calls for one session share the same start.
 */
async function ensureTerminalForSession(appSessionId: string, model?: string): Promise<string | null> {
  if (await findAttachment(appSessionId)) {
    return null;
  }

  const pending = pendingStarts.get(appSessionId);
  if (pending) {
    return pending;
  }

  const start = startTerminalForSession(appSessionId, model)
    .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
  pendingStarts.set(appSessionId, start);
  try {
    const error = await start;
    if (error) {
      completeExternalRun(appSessionId, { exitCode: 1 });
    }
    return error;
  } finally {
    pendingStarts.delete(appSessionId);
  }
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
 * Used by the server composition root on shutdown.
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
 * Whether the web chat drives this session through a tmux terminal rather
 * than through a Claude process of its own.
 *
 * True when a terminal already runs it, and also when nothing runs it yet
 * and tmux is available: the first send then opens a terminal for it, so the
 * conversation lives in exactly one CLI that both the web chat and the user's
 * terminal can reach. False for non-Claude sessions and when tmux is missing.
 *
 * Used by the websocket module's chat gateway to route sends, steers and
 * stops for that session here.
 */
export async function isExternalSession(appSessionId: string): Promise<boolean> {
  if (!dependencies) {
    return false;
  }
  if (await findAttachment(appSessionId)) {
    return true;
  }
  const session = sessionsDb.getSessionById(appSessionId);
  return session?.provider === 'claude' && await isTmuxInstalled();
}

/**
 * Types a message from the web chat into the session's terminal and submits
 * it, opening a tmux terminal for the session first when none runs it. A turn
 * already running in the terminal simply queues it, the same as typing ahead
 * at the keyboard.
 *
 * Used by the websocket module's chat gateway for `chat.send`, `chat.steer`
 * and queued/scheduled turns. `model` only applies when a terminal has to be
 * started. Returns an error message, or null on success.
 */
export async function sendToExternalSession(
  appSessionId: string,
  text: string,
  options: { model?: string } = {},
): Promise<string | null> {
  const startError = await ensureTerminalForSession(appSessionId, options.model);
  if (startError) {
    return startError;
  }

  const attachment = attachments.get(appSessionId);
  if (!attachment) {
    return 'The terminal session is no longer running.';
  }

  if (BLOCKING_PROMPT_PATTERN.test((await captureTmuxPane(attachment.paneId)) ?? '')) {
    return 'The terminal is waiting for an answer to a prompt; answer it there first.';
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
  startExternalRun(attachment.appSessionId, attachment.providerSessionId);
  return null;
}

/**
 * The command the Shell view runs for a Claude session, so that it shows the
 * one terminal the web chat also uses instead of starting a second CLI.
 *
 * - A session already in tmux: attach to its tmux session.
 * - A session no CLI runs: start it in a new tmux session, attached.
 * - A session open in a CLI outside tmux: a message saying so (a second CLI
 *   would fork the conversation).
 *
 * Returns null when tmux is unavailable or the session is not Claude's, and
 * the Shell view keeps its own command. Used by the websocket module's Shell
 * handler.
 */
export async function buildShellCommandForSession(
  appSessionId: string,
  options: { extraFlags?: string } = {},
): Promise<string | null> {
  if (!dependencies || !(await isTmuxInstalled())) {
    return null;
  }

  const attachment = await findAttachment(appSessionId);
  if (attachment) {
    return `exec tmux attach-session -t ${quoteShellArgument(attachment.paneId)}`;
  }

  const session = sessionsDb.getSessionById(appSessionId);
  if (!session || session.provider !== 'claude' || !session.project_path) {
    return null;
  }

  const target = await resolveTerminalSessionTarget(session);
  if (typeof target === 'string') {
    return `printf '%s\\n' ${quoteShellArgument(target)}`;
  }
  const unattachable = findUnattachableProcess(target.providerSessionId);
  if (unattachable) {
    return `printf '%s\\n' ${quoteShellArgument(describeUnattachableProcess(unattachable))}`;
  }

  const claudeBinary = await resolveClaudeBinary();
  if (!claudeBinary) {
    return null;
  }
  const extraFlags = options.extraFlags?.trim() ? ` ${options.extraFlags.trim()}` : '';
  const claudeCommand = buildClaudeCommand(claudeBinary, target) + extraFlags;
  return buildAttachedTmuxSessionCommand({
    name: await pickTmuxSessionName(session.project_path),
    cwd: session.project_path,
    command: claudeCommand,
  });
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

/**
 * Waits until none of these pids is a live Claude CLI process, so a caller
 * that reads the registry next (the running-sessions poll) no longer lists
 * them. Returns the pids still alive at the deadline.
 */
async function waitForCliExit(pids: number[]): Promise<number[]> {
  const deadline = Date.now() + SUSPEND_EXIT_TIMEOUT_MS;
  let alive = pids;
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SPAWN_POLL_MS));
    const processes = await listLiveClaudeCliProcesses();
    alive = alive.filter((pid) => processes.some((entry) => entry.pid === pid));
  }
  return alive;
}

/**
 * Suspends a terminal Claude session: closes every tmux pane a Claude CLI
 * for it runs in, which ends those CLIs and, when one was the last pane of
 * its tmux session, that tmux session too. Usually that is one pane, but a
 * copy resumed by hand in another tmux window runs the same conversation and
 * would otherwise keep it open. The conversation stays on disk; the next
 * message from the web chat resumes it in a new tmux terminal.
 *
 * A turn running in the terminal is cut off. Refused for a session whose
 * terminal is still being started, and for one open only in a CLI outside
 * tmux, which this module cannot close.
 *
 * Used by the external-sessions routes for the sidebar's "Suspend session"
 * action. Returns an error message, or null once the CLIs have exited.
 */
export async function suspendExternalSession(appSessionId: string): Promise<string | null> {
  if (!dependencies) {
    return 'Terminal sessions are not available on this server.';
  }
  if (pendingStarts.has(appSessionId)) {
    return 'The terminal for this session is still starting; try again in a moment.';
  }

  const session = sessionsDb.getSessionById(appSessionId);
  const providerSessionId = session?.provider_session_id;
  if (!session || session.provider !== 'claude' || !providerSessionId) {
    return 'This session is not running in a terminal.';
  }

  const [processes, panes] = await Promise.all([listLiveClaudeCliProcesses(), listTmuxPanes()]);
  const sessionProcesses = processes.filter((entry) => entry.providerSessionId === providerSessionId);
  const targets: Array<{ pid: number; paneId: string }> = [];
  const outsideTmux: number[] = [];
  for (const cliProcess of sessionProcesses) {
    const paneId = panes.size > 0 ? await resolvePane(cliProcess.pid, panes) : null;
    if (paneId) {
      targets.push({ pid: cliProcess.pid, paneId });
    } else {
      outsideTmux.push(cliProcess.pid);
    }
  }

  if (targets.length === 0) {
    return outsideTmux.length > 0
      ? `This conversation runs in a Claude CLI outside tmux (pid ${outsideTmux.join(', ')}); close it there.`
      : 'This session is not running in a terminal.';
  }

  const failures: string[] = [];
  for (const target of targets) {
    try {
      await killTmuxPane(target.paneId);
    } catch (error) {
      failures.push(`${target.paneId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log('[ExternalSessions] suspended terminal session', { appSessionId, targets, failures });

  // Ended as aborted so a turn that was running reads as stopped, not done.
  completeExternalRun(appSessionId, { exitCode: 0, aborted: true });
  const attachment = attachments.get(appSessionId);
  if (attachment) {
    detach(attachment);
  }

  const stillAlive = await waitForCliExit(targets.map((target) => target.pid));
  await scan();
  if (failures.length > 0) {
    return `Could not close ${failures.join('; ')}`;
  }
  if (stillAlive.length > 0) {
    return `The terminal was closed, but Claude (pid ${stillAlive.join(', ')}) has not exited yet.`;
  }
  if (outsideTmux.length > 0) {
    return `Closed the tmux terminal, but the conversation is still open in a Claude CLI outside tmux (pid ${outsideTmux.join(', ')}).`;
  }
  return null;
}

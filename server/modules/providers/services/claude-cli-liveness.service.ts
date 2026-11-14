import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { LiveClaudeCliProcess } from '@/shared/types.js';

/**
 * Claude Code keeps one file per running session here, named `<pid>.json`.
 * The directory belongs to the CLI, not to CloudCLI: it is only ever read.
 */
const registryDirectory = () => path.join(os.homedir(), '.claude', 'sessions');

/**
 * Upper bound on registry files inspected per poll.
 *
 * The running-sessions endpoint is polled continuously, so a directory left
 * full of stale files by repeated crashes must not turn every poll into
 * unbounded filesystem work. Real installations hold a handful of entries.
 */
const MAX_REGISTRY_FILES = 256;

/**
 * Whether `pid` is still the process the registry recorded.
 *
 * A registry file outlives a crash, so its mere presence proves nothing. The
 * signal-0 probe answers "does this pid exist" (EPERM means it exists but is
 * owned by someone else, which still counts), and on Linux the recorded
 * `procStart` is compared against the kernel's start-time for that pid so a
 * reused pid cannot be mistaken for the original process.
 */
async function isRecordedProcessAlive(pid: number, procStart: unknown): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EPERM') {
      return false;
    }
  }

  if (process.platform !== 'linux' || typeof procStart !== 'string' || !procStart) {
    return true;
  }

  try {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
    // The comm field is parenthesised and may itself contain spaces, so the
    // fields are counted from the last ')'. starttime is the 22nd field
    // overall, i.e. the 20th of what follows the comm field.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] === procStart;
  } catch {
    // No procfs entry means the process is gone between the two checks.
    return false;
  }
}

/** Reads one registry file, returning null for anything that is not a live CLI process. */
async function readLiveProcess(filePath: string): Promise<LiveClaudeCliProcess | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    // Unreadable, half-written or malformed entries are simply not evidence
    // of a running session.
    return null;
  }

  const record = parsed as Record<string, unknown> | null;
  if (!record || typeof record !== 'object') {
    return null;
  }

  const providerSessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
  const pid = typeof record.pid === 'number' ? record.pid : NaN;
  if (!providerSessionId || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  if (!(await isRecordedProcessAlive(pid, record.procStart))) {
    return null;
  }

  return {
    pid,
    providerSessionId,
    cwd: typeof record.cwd === 'string' && record.cwd ? record.cwd : null,
    status: record.status === 'busy' ? 'busy' : 'idle',
    startedAt: typeof record.startedAt === 'number' ? record.startedAt : Date.now(),
  };
}

/**
 * Lists every Claude CLI process that is alive right now, busy or idle.
 *
 * Used by the external-sessions module, which needs idle processes too: an
 * idle terminal is exactly the one a message from the web chat is typed into.
 * Also used by the providers module's sessions service for the
 * running-sessions poll: busy processes are reported as turns in progress,
 * and every live process is listed for the sidebar's Running tab.
 * Liveness is ephemeral, so it is recomputed on every call instead of being
 * cached or persisted.
 */
export async function listLiveClaudeCliProcesses(): Promise<LiveClaudeCliProcess[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(registryDirectory());
  } catch {
    // No registry directory at all is the normal case for an install that has
    // never run the CLI, and an unreadable one is not worth failing a poll for.
    return [];
  }

  const registryFiles = entries.filter((entry) => entry.endsWith('.json')).slice(0, MAX_REGISTRY_FILES);
  const processes = await Promise.all(
    registryFiles.map((entry) => readLiveProcess(path.join(registryDirectory(), entry))),
  );

  return processes.filter((entry): entry is LiveClaudeCliProcess => entry !== null);
}

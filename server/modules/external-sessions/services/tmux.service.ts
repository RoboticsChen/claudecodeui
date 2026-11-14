import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * How far up the process tree a Claude CLI pid is walked looking for the pid
 * tmux started in a pane. `tmux new 'claude'` makes the CLI the pane process
 * itself; a pane that runs a shell first puts the CLI one or two levels down
 * (shell → claude, or shell → wrapper → claude).
 */
const MAX_PARENT_HOPS = 6;

/**
 * The gap between pasting a message and pressing Enter.
 *
 * The TUI receives a bracketed paste as one burst and has to finish
 * inserting it before Enter can submit it; without the gap a long paste can
 * still be landing when the Enter keystroke arrives and gets split by it.
 */
const ENTER_AFTER_PASTE_DELAY_MS = 150;

const SUBPROCESS_TIMEOUT_MS = 5_000;

/**
 * Process-tree walker for `resolveTmuxPaneForPid`. Kept as a parameter so a
 * test can describe a tree without real processes.
 */
type ReadParentPid = (pid: number) => Promise<number | null>;

async function readParentPidFromPs(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    const parentPid = Number.parseInt(stdout.trim(), 10);
    return Number.isInteger(parentPid) && parentPid > 1 ? parentPid : null;
  } catch {
    // `ps` exits non-zero for a pid that is gone.
    return null;
  }
}

/**
 * Lists every tmux pane on the default server as `pane_pid → pane_id`.
 *
 * Used by the external-sessions service to find which pane a Claude CLI
 * process runs in. Returns an empty map when tmux is not installed or no
 * server is running, which simply means no session is attachable.
 */
export async function listTmuxPanes(): Promise<Map<number, string>> {
  try {
    const { stdout } = await execFileAsync('tmux', ['list-panes', '-a', '-F', '#{pane_pid} #{pane_id}'], {
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    const panes = new Map<number, string>();
    for (const line of stdout.split('\n')) {
      const [pidText, paneId] = line.trim().split(' ');
      const pid = Number.parseInt(pidText ?? '', 10);
      if (Number.isInteger(pid) && paneId?.startsWith('%')) {
        panes.set(pid, paneId);
      }
    }
    return panes;
  } catch {
    return new Map();
  }
}

/**
 * Finds the tmux pane a process runs in by walking up from `pid` until a
 * pane's own process is reached.
 *
 * Used by the external-sessions service. Returns null for a process that is
 * not inside tmux (an ordinary terminal tab, the CloudCLI Shell view's PTY),
 * which the web chat cannot type into.
 */
export async function resolveTmuxPaneForPid(
  pid: number,
  panes: Map<number, string>,
  readParentPid: ReadParentPid = readParentPidFromPs,
): Promise<string | null> {
  let current: number | null = pid;
  for (let hop = 0; current !== null && hop <= MAX_PARENT_HOPS; hop += 1) {
    const paneId = panes.get(current);
    if (paneId) {
      return paneId;
    }
    current = await readParentPid(current);
  }
  return null;
}

/** Runs one command to completion and returns its stdout. */
async function runCommand(file: string, args: string[], stdin?: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const label = file === 'tmux' ? `tmux ${args[0]}` : `${file} … tmux`;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${label} timed out`));
    }, SUBPROCESS_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${label} failed (${code}): ${stderr.trim()}`));
      }
    });
    child.stdin.end(stdin ?? '');
  });
}

async function runTmux(args: string[], stdin?: string): Promise<string> {
  return runCommand('tmux', args, stdin);
}

/**
 * Whether `systemd-run --user --scope` works here, probed once.
 *
 * CloudCLI usually runs as a systemd user service. A tmux command that has to
 * start the tmux server forks that server into the caller's cgroup, so
 * restarting CloudCLI (`KillMode=control-group`) would kill the server and,
 * with it, every terminal session the user has. Starting it through a scope
 * of its own keeps the terminals alive across restarts.
 */
let userScopeAvailable: Promise<boolean> | null = null;

function canRunInUserScope(): Promise<boolean> {
  if (!userScopeAvailable) {
    userScopeAvailable = process.platform !== 'linux'
      ? Promise.resolve(false)
      : runCommand('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--', 'true'])
        .then(() => true)
        .catch(() => false);
  }
  return userScopeAvailable;
}

/** The argv that runs `tmux <args>` outside CloudCLI's own cgroup when it can. */
async function tmuxServerSafeArgv(args: string[]): Promise<string[]> {
  return (await canRunInUserScope())
    ? ['systemd-run', '--user', '--scope', '--quiet', '--collect', '--', 'tmux', ...args]
    : ['tmux', ...args];
}

/**
 * Quotes one word for a POSIX shell.
 *
 * Used here and by the external-sessions service to build the command a tmux
 * pane or the Shell view's bash runs; both are parsed by `sh -c`.
 */
export function quoteShellArgument(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Whether tmux is installed. Probed once; used by the external-sessions
 * service to decide whether terminal sessions can be offered at all.
 */
let tmuxInstalled: Promise<boolean> | null = null;

export function isTmuxInstalled(): Promise<boolean> {
  if (!tmuxInstalled) {
    tmuxInstalled = process.platform === 'win32'
      ? Promise.resolve(false)
      : runCommand('tmux', ['-V']).then(() => true).catch(() => false);
  }
  return tmuxInstalled;
}

/**
 * Whether a tmux session with exactly this name exists.
 *
 * Used by the external-sessions service to pick a free name for a new
 * terminal session. The `=` prefix makes tmux match the whole name rather
 * than a prefix of another session's name.
 */
export async function hasTmuxSession(name: string): Promise<boolean> {
  try {
    await runTmux(['has-session', '-t', `=${name}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts a detached tmux session that runs `command` and returns its pane.
 *
 * Used by the external-sessions service to open a terminal for a session the
 * web chat sends to while no terminal runs it. `command` is parsed by `sh -c`
 * in the pane; callers start it with `exec` so the pane's process is the
 * program itself. `env` is set on the session (tmux `-e`), on top of the tmux
 * server's own environment.
 */
export async function createDetachedTmuxSession(input: {
  name: string;
  cwd: string;
  command: string;
  env?: Record<string, string>;
}): Promise<{ paneId: string; panePid: number }> {
  const envArgs = Object.entries(input.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const [file, ...args] = await tmuxServerSafeArgv([
    'new-session', '-d', '-P', '-F', '#{pane_id} #{pane_pid}',
    '-s', input.name, '-c', input.cwd, '-x', '200', '-y', '50',
    ...envArgs,
    input.command,
  ]);
  const stdout = await runCommand(file, args);
  const [paneId, pidText] = stdout.trim().split(' ');
  const panePid = Number.parseInt(pidText ?? '', 10);
  if (!paneId?.startsWith('%') || !Number.isInteger(panePid)) {
    throw new Error(`tmux new-session printed no pane: ${stdout.trim()}`);
  }
  return { paneId, panePid };
}

/**
 * The shell command that starts an attached tmux session running `command`,
 * for a terminal (the Shell view's PTY) to run in the foreground.
 *
 * Used by the external-sessions service. Goes through the same user scope as
 * `createDetachedTmuxSession`, so a tmux server started here survives a
 * CloudCLI restart even though the PTY that started it does not.
 */
export async function buildAttachedTmuxSessionCommand(input: {
  name: string;
  cwd: string;
  command: string;
  env?: Record<string, string>;
}): Promise<string> {
  const envArgs = Object.entries(input.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const argv = await tmuxServerSafeArgv(['new-session', '-s', input.name, '-c', input.cwd, ...envArgs, input.command]);
  return `exec ${argv.map(quoteShellArgument).join(' ')}`;
}

/**
 * The text a pane shows now, or null once the pane is gone.
 *
 * Used by the external-sessions service while it waits for a Claude CLI it
 * started to come up, to notice a prompt that needs the user (folder trust)
 * or a CLI that exited.
 */
export async function captureTmuxPane(paneId: string): Promise<string | null> {
  try {
    return await runTmux(['capture-pane', '-p', '-t', paneId]);
  } catch {
    return null;
  }
}

/**
 * Types `text` into a tmux pane as one message and submits it.
 *
 * Used by the external-sessions service for every message the web chat sends
 * to a terminal session. The text goes through a tmux buffer and a bracketed
 * paste (`paste-buffer -p`), so newlines stay inside the message instead of
 * submitting each line, and no character is interpreted as a key name. The
 * buffer gets a unique name and is deleted by the paste (`-d`), so two sends
 * at once cannot paste each other's text.
 */
export async function submitTextToTmuxPane(paneId: string, text: string): Promise<void> {
  const bufferName = `cloudcli-${randomUUID()}`;
  await runTmux(['load-buffer', '-b', bufferName, '-'], text);
  await runTmux(['paste-buffer', '-p', '-d', '-b', bufferName, '-t', paneId]);
  await new Promise((resolve) => setTimeout(resolve, ENTER_AFTER_PASTE_DELAY_MS));
  await runTmux(['send-keys', '-t', paneId, 'Enter']);
}

/**
 * Presses Escape in a tmux pane, which interrupts the Claude TUI's running
 * turn the same way it does at the keyboard.
 *
 * Used by the external-sessions service for the web chat's stop button.
 */
export async function sendEscapeToTmuxPane(paneId: string): Promise<void> {
  await runTmux(['send-keys', '-t', paneId, 'Escape']);
}

/**
 * Line pairs cleared by `clearTmuxPaneInput`. Each `C-u` empties one line of
 * the prompt and the `BSpace` after it joins the line above, so this bounds
 * how tall a draft can be cleared. Extra pairs on an empty prompt do nothing.
 */
const CLEAR_INPUT_LINE_PAIRS = 64;

/**
 * Empties the Claude TUI's input box.
 *
 * Used by the external-sessions service after an interrupt: the TUI puts an
 * interrupted message back into the input box, and the next message from the
 * web chat would otherwise be pasted after it and submitted together with it.
 */
export async function clearTmuxPaneInput(paneId: string): Promise<void> {
  const keys: string[] = [];
  for (let index = 0; index < CLEAR_INPUT_LINE_PAIRS; index += 1) {
    keys.push('C-u', 'BSpace');
  }
  await runTmux(['send-keys', '-t', paneId, ...keys]);
}

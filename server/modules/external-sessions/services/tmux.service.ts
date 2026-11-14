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

async function runTmux(args: string[], stdin?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tmux', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`tmux ${args[0]} timed out`));
    }, SUBPROCESS_TIMEOUT_MS);

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
        resolve();
      } else {
        reject(new Error(`tmux ${args[0]} failed (${code}): ${stderr.trim()}`));
      }
    });
    child.stdin.end(stdin ?? '');
  });
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

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTmuxPaneForPid } from '@/modules/external-sessions/services/tmux.service.js';

/** A fake process tree: child pid → parent pid. */
function parentReader(tree: Record<number, number>) {
  return async (pid: number) => tree[pid] ?? null;
}

test('a CLI that tmux started directly is its pane process', async () => {
  const panes = new Map([[100, '%3']]);
  assert.equal(await resolveTmuxPaneForPid(100, panes, parentReader({})), '%3');
});

test('a CLI started from a shell in the pane is found through its parents', async () => {
  // pane shell 200 → wrapper 201 → claude 202
  const panes = new Map([[200, '%7']]);
  assert.equal(await resolveTmuxPaneForPid(202, panes, parentReader({ 202: 201, 201: 200 })), '%7');
});

test('a CLI outside tmux has no pane', async () => {
  const panes = new Map([[200, '%7']]);
  // claude 300 → terminal shell 301 → login 302, none of them a pane
  assert.equal(await resolveTmuxPaneForPid(300, panes, parentReader({ 300: 301, 301: 302 })), null);
});

test('the walk stops after a bounded number of parents', async () => {
  // A pane far above the CLI (a tmux server started from inside another
  // session's shell, say) is not the CLI's own pane.
  const tree: Record<number, number> = {};
  for (let pid = 500; pid > 490; pid -= 1) {
    tree[pid] = pid - 1;
  }
  const panes = new Map([[490, '%9']]);
  assert.equal(await resolveTmuxPaneForPid(500, panes, parentReader(tree)), null);
});

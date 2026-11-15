import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';

/**
 * A latest-history refresh that fails (a mobile page frozen in the background
 * drops its requests) must report itself as deferred, so the refresh
 * coordinator keeps the session pending and retries, instead of treating the
 * last signal of a finished turn as handled.
 */

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    },
  },
}));

const row = (id: string): NormalizedMessage => ({
  id,
  kind: 'text',
  role: 'assistant',
  provider: 'claude',
  sessionId: 'session-1',
  content: `row ${id}`,
  timestamp: `2026-01-01T00:00:0${id}.000Z`,
} as NormalizedMessage);

const page = (rows: NormalizedMessage[]) => ({
  ok: true,
  json: async () => ({ data: { messages: rows, total: rows.length, hasMore: false } }),
});

beforeEach(() => {
  sessionMessages.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

it('reports a failed refresh as deferred and applies the reply on the retry', async () => {
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  const { result } = renderHook(() => useSessionStore());

  sessionMessages.mockResolvedValueOnce(page([row('1')]));
  await act(async () => {
    await result.current.fetchFromServer('session-1', { limit: 20, offset: 0 });
  });

  sessionMessages.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  let failed: { deferred: boolean; applied: boolean } | undefined;
  await act(async () => {
    failed = await result.current.refreshLatestFromServer('session-1');
  });
  assert.equal(failed?.applied, false);
  assert.equal(failed?.deferred, true, 'a failed refresh must stay pending so it is retried');

  sessionMessages.mockResolvedValueOnce(page([row('1'), row('2')]));
  await act(async () => {
    await result.current.refreshLatestFromServer('session-1');
  });
  assert.deepEqual(result.current.getMessages('session-1').map((m) => m.id), ['1', '2']);
});

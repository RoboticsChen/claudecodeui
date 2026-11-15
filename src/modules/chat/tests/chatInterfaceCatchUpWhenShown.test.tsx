import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { Project, ProjectSession, ServerEvent } from '@/shared/types';

/**
 * A backgrounded mobile page often keeps its websocket open, so no reconnect
 * catch-up runs, while the transcript refreshes it tried while frozen were
 * dropped. A turn that finished meanwhile sends nothing more, so unless showing
 * the page again re-syncs, the reply never appears and the agent looks stuck.
 */

const harness = vi.hoisted(() => ({
  sessionId: 'session-a',
  subscribe: (_listener: (event: ServerEvent) => void) => () => {},
  requestLatestMessages: vi.fn(async (_sessionId: string, _allowNetwork?: boolean) => {}),
  useScheduledMessages: vi.fn((_sessionId: string | null, _subscribe?: unknown) => ({
    scheduledMessages: [],
    schedule: async () => null,
    cancel: async () => false,
  })),
}));

vi.mock('@/modules/chat/composer/useScheduledMessages', () => ({
  useScheduledMessages: harness.useScheduledMessages,
}));
vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: harness.subscribe }),
}));
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useProcessingSessions: () => new Map(),
  useSessionProtectionActions: () => ({
    markSessionProcessing: () => {},
    markSessionIdle: () => {},
    markSessionBackground: () => {},
    getSessionActivity: () => null,
  }),
}));
vi.mock('@/modules/task-master', () => ({
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }),
}));
vi.mock('@/modules/command-palette', () => ({ usePaletteOpsRegister: () => {} }));
vi.mock('@/modules/chat/hooks/useChatProviderState', () => ({
  useChatProviderState: () => ({ provider: 'claude', pendingPermissionRequests: [] }),
}));
vi.mock('@/modules/chat/hooks/useChatSessionState', () => ({
  useChatSessionState: () => ({
    chatMessages: [],
    currentSessionId: harness.sessionId,
    setCurrentSessionId: () => {},
    requestLatestMessages: harness.requestLatestMessages,
  }),
}));
vi.mock('@/modules/chat/hooks/useChatRealtimeHandlers', () => ({ useChatRealtimeHandlers: () => {} }));
vi.mock('@/modules/chat/hooks/useChatComposerState', () => ({
  useChatComposerState: () => ({ input: '', setInput: () => {}, textareaRef: { current: null } }),
}));
vi.mock('@/modules/chat/hooks/useSessionStore', () => ({ useSessionStore: () => ({}) }));
vi.mock('@/modules/chat/transcript/ChatMessagesPane', () => ({ default: () => null }));
vi.mock('@/modules/chat/composer/ChatComposer', () => ({ default: () => null }));
vi.mock('@/modules/chat/modals/CommandResultModal', () => ({ default: () => null }));

const { default: ChatInterface } = await import('@/modules/chat/ChatInterface');

const project: Project = { projectId: 'p1', displayName: 'repo', fullPath: '/work/repo', path: '/work/repo' };
const session: ProjectSession = { id: harness.sessionId, provider: 'claude' };

let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

beforeEach(() => {
  harness.requestLatestMessages.mockClear();
  visibility = 'visible';
});

function renderChat(sendMessage: (message: unknown) => void) {
  return render(
    <ChatInterface
      isActive
      selectedProject={project}
      selectedSession={session}
      ws={null}
      sendMessage={sendMessage}
    />,
  );
}

const subscribesFor = (sent: unknown[]) => sent.filter(
  (message) => (message as { type?: string }).type === 'chat.subscribe',
);

test('showing the page again refreshes the transcript and re-subscribes the viewed session', async () => {
  const sent: unknown[] = [];
  renderChat((message) => sent.push(message));
  harness.requestLatestMessages.mockClear();
  sent.length = 0;

  visibility = 'hidden';
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(harness.requestLatestMessages.mock.calls.length, 0, 'hiding the page must not fetch');
  assert.equal(subscribesFor(sent).length, 0);

  visibility = 'visible';
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  assert.deepEqual(harness.requestLatestMessages.mock.calls.map(([id]) => id), [harness.sessionId]);
  const subscribes = subscribesFor(sent) as Array<{ sessions: Array<{ sessionId: string }> }>;
  assert.equal(subscribes.length, 1);
  assert.equal(subscribes[0].sessions[0].sessionId, harness.sessionId);
});

test('a page restored from the back-forward cache catches up too', async () => {
  const sent: unknown[] = [];
  renderChat((message) => sent.push(message));
  harness.requestLatestMessages.mockClear();
  sent.length = 0;

  await act(async () => { window.dispatchEvent(new Event('pageshow')); });
  assert.equal(harness.requestLatestMessages.mock.calls.length, 1);
  assert.equal(subscribesFor(sent).length, 1);
});

test('the listeners go away with the chat', async () => {
  const view = renderChat(() => {});
  view.unmount();
  harness.requestLatestMessages.mockClear();

  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(harness.requestLatestMessages.mock.calls.length, 0);
});

import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { TFunction } from 'i18next';
import { test, vi } from 'vitest';

import SessionOptions from '@/modules/sidebar/SessionOptions';

vi.mock('@/shared/api', () => ({
  api: {
    providerSessionId: async () => ({
      ok: true,
      json: async () => ({ data: { sessionId: 'native-session-1' } }),
    }),
    providers: {
      capabilities: async () => ({
        json: async () => ({ success: true, data: { providers: [] } }),
      }),
    },
  },
}));

const t = ((key: string) => key) as TFunction;
const noop = () => {};

const optionsProps = (
  overrides: Partial<ComponentProps<typeof SessionOptions>> = {},
): ComponentProps<typeof SessionOptions> => ({
  sessionId: 'session-1',
  sessionName: 'Session one',
  provider: 'claude',
  projectId: 'project-1',
  isProcessing: false,
  isEditing: false,
  renameDraft: '',
  onRenameDraftChange: noop,
  onStartEditingSession: noop,
  onCancelEditingSession: noop,
  onSaveEditingSession: noop,
  onArchiveSession: noop,
  onDeleteSession: noop,
  t,
  ...overrides,
});

const openMenu = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Session options for Session one' }));
  });
};

// The stub `t` returns the key, so the item is found by its i18n key.
const SUSPEND_ITEM = /sessions\.suspendSession/;

test('suspend is offered only when the caller binds it, i.e. a terminal CLI is live', async () => {
  render(<SessionOptions {...optionsProps()} />);
  await openMenu();
  assert.equal(screen.queryByRole('menuitem', { name: SUSPEND_ITEM }), null);
});

test('suspend calls the bound handler, even while a turn is running', async () => {
  const onSuspend = vi.fn();
  render(<SessionOptions {...optionsProps({ onSuspend, isProcessing: true })} />);
  await openMenu();

  fireEvent.click(screen.getByRole('menuitem', { name: SUSPEND_ITEM }));
  assert.equal(onSuspend.mock.calls.length, 1);
});

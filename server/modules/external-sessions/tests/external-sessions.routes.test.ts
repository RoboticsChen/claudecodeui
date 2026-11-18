import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { createExternalSessionsRouter } from '@/modules/external-sessions/external-sessions.routes.js';
import { AppError } from '@/shared/utils.js';

async function withServer(
  suspend: (appSessionId: string) => Promise<string | null>,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use('/api/external-sessions', createExternalSessionsRouter(suspend));
  // The same AppError translation the server's global error middleware does.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ success: false, error: { message: err instanceof Error ? err.message : String(err) } });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('suspend forwards the session id and reports success', async () => {
  const calls: string[] = [];
  await withServer(async (sessionId) => {
    calls.push(sessionId);
    return null;
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/external-sessions/abc-123/suspend`, { method: 'POST' });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { data: unknown };
    assert.deepEqual(payload.data, { suspended: true });
  });
  assert.deepEqual(calls, ['abc-123']);
});

test('a refused suspend is a 409 carrying the explanation', async () => {
  await withServer(async () => 'This session is not running in a terminal.', async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/external-sessions/abc/suspend`, { method: 'POST' });
    assert.equal(response.status, 409);
    const payload = (await response.json()) as { error: { message: string } };
    assert.equal(payload.error.message, 'This session is not running in a terminal.');
  });
});

test('a malformed session id is rejected before the service is called', async () => {
  let called = false;
  await withServer(async () => {
    called = true;
    return null;
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/external-sessions/${encodeURIComponent('a b')}/suspend`, { method: 'POST' });
    assert.equal(response.status, 400);
  });
  assert.equal(called, false);
});

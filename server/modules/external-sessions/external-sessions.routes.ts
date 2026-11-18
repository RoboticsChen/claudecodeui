import express, { type Request, type Response } from 'express';

import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

/** The app session ids CloudCLI mints and the provider routes accept. */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;

function parseSessionId(value: unknown): string {
  const sessionId = typeof value === 'string' ? value.trim() : '';
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new AppError('Invalid sessionId.', {
      code: 'INVALID_SESSION_ID',
      statusCode: 400,
    });
  }
  return sessionId;
}

/**
 * Builds the transport-only router. Used by the module's composition file,
 * which passes the real suspend, and by the route tests, which pass a fake
 * one so they never load the database or the terminal monitor.
 */
export function createExternalSessionsRouter(
  suspend: (appSessionId: string) => Promise<string | null>,
): express.Router {
  const router = express.Router();

  // Suspends a terminal Claude session by closing its tmux pane. A refusal
  // (not in a terminal, outside tmux, still starting) is a 409 carrying the
  // explanation for the user.
  router.post(
    '/:sessionId/suspend',
    asyncHandler(async (req: Request, res: Response) => {
      const sessionId = parseSessionId(req.params.sessionId);
      const error = await suspend(sessionId);
      if (error) {
        throw new AppError(error, { code: 'SUSPEND_FAILED', statusCode: 409 });
      }
      res.json(createApiSuccessResponse({ suspended: true }));
    }),
  );

  return router;
}

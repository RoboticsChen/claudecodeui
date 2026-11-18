import { createExternalSessionsRouter } from '@/modules/external-sessions/external-sessions.routes.js';
import { suspendExternalSession } from '@/modules/external-sessions/services/external-sessions.service.js';

/**
 * The external-sessions HTTP routes wired to the real terminal-session
 * service. Used by the server entrypoint, through the module barrel, to mount
 * the sidebar's "Suspend session" endpoint.
 */
export const externalSessionsRoutes = createExternalSessionsRouter(suspendExternalSession);

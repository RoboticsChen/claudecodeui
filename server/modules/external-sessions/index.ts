export {
  buildShellCommandForSession,
  interruptExternalSession,
  isExternalSession,
  isExternalSessionMonitorRunning,
  sendToExternalSession,
  startExternalSessionMonitor,
  stopExternalSessionMonitor,
} from './services/external-sessions.service.js';

// externalSessionsRoutes: mounted by the server entrypoint for the sidebar's "Suspend session" action.
export { externalSessionsRoutes } from './external-sessions.module.js';

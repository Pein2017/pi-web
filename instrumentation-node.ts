import { configureHttpDispatcher } from "@/lib/http-dispatcher";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { startSharedPiUpdateObserver } from "@/lib/shared-pi-update.cjs";
import { hasBusyRpcWorkForRuntimeUpdate, shutdownIdleRpcSessionsForRuntimeUpdate } from "@/lib/rpc-manager";
import { hasOpenTerminalShells } from "@/lib/terminal-manager";

export function registerNodeInstrumentation(): void {
  configureHttpDispatcher();
  startSharedPiUpdateObserver({
    hasBusyWork: () => hasBusyRpcWorkForRuntimeUpdate() || hasOpenTerminalShells(),
    shutdownIdleSessions: shutdownIdleRpcSessionsForRuntimeUpdate,
  });

  // In production Next 16 answers SIGINT/SIGTERM with server.close() and waits
  // for every connection to end, without a timeout. SSE streams only end when
  // the client disconnects, so close them here or the process never exits.
  const shutdownStreams = () => closeAllAgentEventStreams();
  process.on("SIGINT", shutdownStreams);
  process.on("SIGTERM", shutdownStreams);
}

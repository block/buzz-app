// A plugin-owned transport with an execution-owned lifetime. The host already
// supplies loopback authentication and closes transports on plugin unload.
import type { HostMcpServer, McpHandler } from "../features/host/service";

export async function connectMcp(
  serve: (handler: McpHandler) => Promise<HostMcpServer>,
  handler: McpHandler,
  signal: AbortSignal,
): Promise<HostMcpServer> {
  signal.throwIfAborted();
  let stopped = false;
  const check = () => {
    signal.throwIfAborted();
    if (stopped) throw new Error("This agent connection has closed");
  };
  const server = await serve(async (message) => {
    check();
    const result = await handler(message);
    check();
    return result;
  });
  const close = () => {
    stopped = true;
    signal.removeEventListener("abort", abort);
    return server.close();
  };
  const abort = () => void close();
  signal.addEventListener("abort", abort, { once: true });
  void server.closed.then(() => {
    stopped = true;
    signal.removeEventListener("abort", abort);
  });
  if (signal.aborted) {
    await close();
    signal.throwIfAborted();
  }
  return Object.freeze({ ...server, close });
}

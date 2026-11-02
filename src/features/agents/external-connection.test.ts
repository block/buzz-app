import { expect, it, vi } from "vitest";
import type { HostMcpServer } from "../host/service";
import { createExternalConnection } from "./external-connection";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function server() {
  const ended = deferred<void>();
  return {
    url: "http://127.0.0.1:1234/mcp",
    headers: [{ name: "Authorization", value: "Bearer test-only-token" }],
    closed: ended.promise,
    close: vi.fn(async () => {
      ended.resolve();
    }),
  };
}

it("keeps the descriptor out of state and removes copy access after admission or revoke", async () => {
  const transport = server();
  let admit = () => {};
  let lifetime: AbortSignal | undefined;
  const connection = createExternalConnection({
    connectExternal: async (_, signal, connected) => {
      lifetime = signal;
      admit = connected;
      return transport;
    },
  });
  await connection.create("test-agent");
  expect(JSON.parse(connection.descriptor())).toEqual({
    version: 1,
    url: "http://127.0.0.1:1234/mcp",
    token: "test-only-token",
  });
  expect(JSON.stringify(connection.snapshot())).not.toContain(
    "test-only-token",
  );
  admit();
  expect(connection.snapshot().phase).toBe("connected");
  expect(() => connection.descriptor()).toThrow("new connection");
  await connection.revoke();
  expect(lifetime?.aborted).toBe(true);
  expect(transport.close).toHaveBeenCalledOnce();
  expect(connection.snapshot().phase).toBe("off");
});

it("closes a server that starts after owner revocation", async () => {
  const pending = deferred<HostMcpServer>();
  const started = deferred<void>();
  const transport = server();
  const connection = createExternalConnection({
    connectExternal: async () => {
      started.resolve();
      return pending.promise;
    },
  });
  const creating = connection.create("test-agent");
  try {
    await started.promise;
    await connection.revoke();
  } finally {
    pending.resolve(transport);
  }
  await creating;
  expect(transport.close).toHaveBeenCalledOnce();
  expect(connection.snapshot().phase).toBe("off");
  expect(() => connection.descriptor()).toThrow();
});

it("requires a new grant after the owning transport ends", async () => {
  const transport = server();
  const connection = createExternalConnection({
    connectExternal: async () => transport,
  });
  await connection.create("test-agent");
  await transport.close();
  expect(connection.snapshot().phase).toBe("ended");
  expect(() => connection.descriptor()).toThrow("new connection");
});

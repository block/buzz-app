import { expect, it, vi } from "vitest";
import type { AgentHandle } from "../features/agents/service";
import { appClient } from "./app-client";

it("carries connection authorities independently of query event authors", async () => {
  const query = vi.fn(async () => []);
  const client = appClient(
    { pubkey: "agent", query } as unknown as AgentHandle,
    {
      cwd: "/workspace",
      spawn: vi.fn(),
      memories: async () => ({ entries: [], partial: false }),
      relayAuthor: "trusted-relay",
      signingAuthority: "trusted-workflows",
    },
  );
  expect(client.relayAuthor).toBe("trusted-relay");
  expect(client.signingAuthority).toBe("trusted-workflows");
  await client.query([{ kinds: [39000] }]);
  expect(query).toHaveBeenCalledWith([{ kinds: [39000] }]);
});

it("does not invent authority when a host has none", () => {
  const client = appClient({ pubkey: "agent" } as AgentHandle, {
    cwd: "/workspace",
    spawn: vi.fn(),
    memories: async () => ({ entries: [], partial: false }),
  });
  expect(client.relayAuthor).toBeUndefined();
  expect(client.signingAuthority).toBeUndefined();
});

it("withholds a query result when the owning turn ends during the read", async () => {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const query = vi.fn(async () => {
    await pending;
    return [];
  });
  const client = appClient(
    { pubkey: "agent", query } as unknown as AgentHandle,
    {
      cwd: "/workspace",
      spawn: vi.fn(),
      signal: controller.signal,
      memories: async () => ({ entries: [], partial: false }),
    },
  );
  const result = client.query([{ kinds: [9] }]);
  expect(query).toHaveBeenCalledOnce();
  controller.abort(new Error("Owning turn ended"));
  release();
  await expect(result).rejects.toThrow("Owning turn ended");
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Host, HostResponse } from "../../../features/host/service";
import { createOAuthSession } from "../oauth/session";
import { deferred } from "../test-helpers";
import { createAgentClient } from "./client";

beforeEach(() =>
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example"),
);
afterEach(() => vi.unstubAllEnvs());
const row = {
  agent_id: "agent-1",
  agent_name: "Helper",
  agent_pubkey: "ab".repeat(32),
  status: "AGENT_STATUS_ACTIVE",
};
const response = (value: unknown, status = 200): HostResponse => ({
  status,
  headers: {},
  body: JSON.stringify(value),
});
async function fixture() {
  const session = createOAuthSession(async () => ({
    value: "secret",
    account: { email: "a@example.com" },
  }));
  await session.signIn();
  const host: Host = {
    runCommand: vi.fn(),
    request: vi.fn(async () =>
      response({ status: "LIST_AGENTS_STATUS_SUCCESS", agents: [row] }),
    ),
  };
  return {
    session,
    host,
    client: createAgentClient(host, session),
    signal: new AbortController().signal,
  };
}
it("lists the authenticated account through the configured native host", async () => {
  const h = await fixture();
  expect(await h.client.list(h.signal)).toEqual([
    {
      id: row.agent_id,
      name: row.agent_name,
      pubkey: row.agent_pubkey,
      status: "Active",
    },
  ]);
  expect(h.host.request).toHaveBeenCalledWith({
    url: "https://builderlab.example/api/goose/v3/beekeeper/list-agents",
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-BB-Session-Credential": "secret",
    },
    body: "{}",
  });
});
it.each([{}, { agents: [] }])(
  "accepts an empty protobuf list %j",
  async (value) => {
    const h = await fixture();
    vi.mocked(h.host.request).mockResolvedValue(
      response({ status: 1, ...value }),
    );
    expect(await h.client.list(h.signal)).toEqual([]);
  },
);
it.each([
  ["AGENT_STATUS_UNATTESTED", "Unattested"],
  [1, "Unattested"],
  ["AGENT_STATUS_REVOKED", "Revoked"],
  [3, "Revoked"],
  ["FUTURE_STATUS", "Unknown"],
  [undefined, "Unknown"],
])(
  "handles agent status %j without treating unknown as active",
  async (status, expected) => {
    const h = await fixture();
    vi.mocked(h.host.request).mockResolvedValue(
      response({ status: 1, agents: [{ ...row, status }] }),
    );
    expect((await h.client.list(h.signal))[0]?.status).toBe(expected);
  },
);
it.each([
  null,
  { status: 2 },
  { status: 1, agents: {} },
  { status: 1, agents: [null] },
  { status: 1, agents: [{ ...row, agent_pubkey: "bad" }] },
])("rejects invalid responses %j", async (value) => {
  const h = await fixture();
  vi.mocked(h.host.request).mockResolvedValue(response(value));
  await expect(h.client.list(h.signal)).rejects.toThrow(
    /invalid|did not return/,
  );
});
it.each([401, 403, 500])(
  "reports HTTP %s without disclosing the provider body",
  async (status) => {
    const h = await fixture();
    vi.mocked(h.host.request).mockResolvedValue(
      response({ error: "private-secret" }, status),
    );
    const error = await h.client.list(h.signal).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("private-secret");
    expect(h.session.snapshot().status).toBe(
      status === 401 ? "signed-out" : "signed-in",
    );
  },
);
it.each(["sign-out", "new-login", "cancel", "dispose"])(
  "discards a held result after %s",
  async (action) => {
    const h = await fixture();
    const held = deferred<HostResponse>();
    vi.mocked(h.host.request).mockReturnValue(held.promise);
    const controller = new AbortController();
    const pending = h.client.list(controller.signal);
    if (action === "cancel") controller.abort();
    else if (action === "dispose") h.session.dispose();
    else {
      h.session.signOut();
      if (action === "new-login") await h.session.signIn();
    }
    held.resolve(
      response(
        { status: 1, agents: [row] },
        action === "new-login" ? 401 : 200,
      ),
    );
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    if (action === "new-login")
      expect(h.session.snapshot().status).toBe("signed-in");
  },
);
it("does not dispatch signed-out or canceled requests", async () => {
  const h = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(h.client.list(controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  h.session.signOut();
  await expect(h.client.list(h.signal)).rejects.toThrow("Sign in");
  expect(h.host.request).not.toHaveBeenCalled();
});

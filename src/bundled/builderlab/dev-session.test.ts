import { afterEach, expect, it, vi } from "vitest";
import { createDevSession, brokerBuilderlab } from "./dev-session";
import { createAgentClient } from "./agents/client";
import { createAppsClient } from "./apps/client";
import { applyApps } from "./apps";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import { deferred } from "./test-helpers";

class Events {
  static all: Events[] = [];
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  close = vi.fn();
  constructor(readonly url: string) {
    Events.all.push(this);
  }
  emit(revision: string, subject: string | null, pending = false) {
    this.onmessage?.({
      data: JSON.stringify({
        revision,
        pending,
        auth: subject
          ? {
              subject,
              email: `${subject}@example.com`,
              expiresAt: "2030",
              capabilities: { can_use_remote_agents: true },
            }
          : null,
      }),
    });
  }
}
function setup() {
  vi.stubGlobal("EventSource", Events);
  vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:1430" } });
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ status: 200, headers: {}, body: "{}" }),
  );
  vi.stubGlobal("fetch", fetch);
  const dev = createDevSession();
  const events = Events.all.at(-1);
  if (!events) throw new Error("Missing server event stream");
  return { ...dev, events, fetch };
}
async function signedIn(
  session: ReturnType<typeof createDevSession>["session"],
) {
  await vi.waitFor(() => expect(session.snapshot().status).toBe("signed-in"));
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  Events.all = [];
});

it("uses the broker only in its development mode, leaving FI and production on their existing owner", () => {
  for (const [dev, live, fi, expected] of [
    [true, "1", "0", true],
    [true, "0", "0", false],
    [true, "1", "1", false],
    [false, "1", "0", false],
  ] as const) {
    vi.stubEnv("DEV", dev);
    vi.stubEnv("VITE_BUZZ_LIVE", live);
    vi.stubEnv("VITE_BUZZ_FEDERATED_IDENTITY", fi);
    expect(brokerBuilderlab()).toBe(expected);
  }
});

it("reloads its public session projection without starting or ending the server login", async () => {
  const h = setup();
  h.events.emit("one", "A");
  await signedIn(h.session);
  expect(h.session.credential()).toEqual({
    revision: "one",
    account: expect.objectContaining({ subject: "A" }),
  });
  expect(h.session.viewerSession()).toMatchObject({
    broker: { origin: "http://127.0.0.1:1430", revision: "one" },
  });
  const viewer = h.session.viewerSession();
  h.session.dispose();
  expect(viewer.signal.aborted).toBe(true);
  expect(h.events.close).toHaveBeenCalled();
  const second = createDevSession();
  const events = Events.all.at(-1);
  if (!events) throw new Error("Missing restored event stream");
  events.emit("one", "A");
  await signedIn(second.session);
  expect(h.fetch).not.toHaveBeenCalled();
  expect(second.session.snapshot().account?.subject).toBe("A");
  second.session.dispose();
});

it("shares agent and Apps transport without an app-held credential and refuses stale operation results", async () => {
  const h = setup();
  h.events.emit("one", "A");
  await signedIn(h.session);
  h.fetch.mockResolvedValueOnce(
    Response.json({
      status: 200,
      headers: {},
      body: JSON.stringify({ status: 1, agents: [] }),
    }),
  );
  await expect(
    createAgentClient(h.session, null).list(new AbortController().signal),
  ).resolves.toEqual([]);
  const owner = h.session.credential();
  const apps = createAppsClient(
    {} as never,
    h.session,
    "https://compose-ctrl.builderlab.xyz",
    h.apps,
  );
  h.fetch.mockResolvedValueOnce(
    Response.json({
      status: 200,
      headers: {},
      body: JSON.stringify({ apps: [] }),
    }),
  );
  await apps.list();
  expect(
    h.fetch.mock.calls.map((call) =>
      JSON.parse((call[1] as RequestInit).body as string),
    ),
  ).toMatchObject([
    { revision: "one", path: "/v3/beekeeper/list-agents", method: "POST" },
    { revision: "one", target: "apps", path: "/v1/agent/apps?scope=owned" },
  ]);
  const held = deferred<Response>();
  h.fetch.mockImplementationOnce(() => held.promise);
  const pending = h.session.request(owner, {
    path: "/v3/beekeeper/list-agents",
  });
  const rejected = expect(pending).rejects.toThrow("session changed");
  const oldViewer = h.session.viewerSession();
  h.events.emit("two", "B");
  await signedIn(h.session);
  expect(oldViewer.signal.aborted).toBe(true);
  held.resolve(Response.json({ status: 200, headers: {}, body: "{}" }));
  await rejected;
  await expect(apps.list()).rejects.toThrow("sign-in changed");
  expect(h.session.snapshot().account?.subject).toBe("B");
  h.events.emit("three", null);
  expect(h.session.snapshot().status).toBe("signed-out");
  h.session.dispose();
});

it("cancels local viewers on sign-out and reconnects to the authoritative state after a stream interruption", async () => {
  const h = setup();
  h.events.emit("one", "A");
  await signedIn(h.session);
  const viewer = h.session.viewerSession();
  h.events.onerror?.();
  expect(viewer.signal.aborted).toBe(true);
  expect(h.session.snapshot()).toMatchObject({
    status: "pending",
    checking: true,
  });
  h.events.emit("one", "A");
  await signedIn(h.session);
  h.session.signOut();
  expect(h.fetch).toHaveBeenCalledWith(
    "/api/builderlab/sign-out",
    expect.objectContaining({ body: JSON.stringify({ revision: "one" }) }),
  );
  h.events.emit("two", null);
  expect(h.session.snapshot()).toEqual({ status: "signed-out" });
  h.session.dispose();
});

it("returns accepted deployment IDs without checking readiness under a replacement dev account", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://app.builderlabstaging.xyz");
  const h = setup();
  const tools = new Map<string, AddedTool>();
  const ctx = {
    panels: { register() {} },
    browser: { available: true, View: () => null },
    host: {},
    agents: { addTool: (tool: AddedTool) => tools.set(tool.name, tool) },
  };
  applyApps(ctx as never, h.session, true, undefined, h.apps);
  h.events.emit("one", "A");
  await signedIn(h.session);
  const accepted = deferred<void>();
  const receipt = deferred<Response>();
  h.fetch.mockResolvedValueOnce(
    Response.json({
      status: 200,
      headers: {},
      body: JSON.stringify({ minimum_client_version: "0.2.0" }),
    }),
  );
  h.fetch.mockImplementationOnce(() => {
    accepted.resolve();
    return receipt.promise;
  });
  const tool = tools.get("apps_deploy");
  if (!tool) throw new Error("Missing apps_deploy tool");
  const pending = tool.call(
    {} as never,
    {},
    {
      app_id: "demo",
      artifact: "/Users/me/artifact.tar.gz",
    },
  );
  try {
    await accepted.promise;
    h.events.emit("two", "B");
    await signedIn(h.session);
  } finally {
    receipt.resolve(
      Response.json({
        status: 201,
        headers: {},
        body: JSON.stringify({ version_id: "v1", deployment_id: "d1" }),
      }),
    );
  }
  expect(JSON.parse(String(await pending))).toMatchObject({
    app_id: "demo",
    version_id: "v1",
    deployment_id: "d1",
    ready: false,
    readiness_error: expect.stringMatching(/sign-in changed/),
  });
  expect(h.fetch).toHaveBeenCalledTimes(2);
  expect(h.session.snapshot().account?.subject).toBe("B");
  h.session.dispose();
});

it.each(["current", "canceled", "disposed"] as const)(
  "handles login failure after pending and signed-out SSE when the attempt is %s",
  async (mode) => {
    const h = setup();
    h.events.emit("one", null);
    const response = deferred<Response>();
    h.fetch.mockImplementationOnce(() => response.promise);
    const pending = h.session.signIn();
    // The broker announces pending, then revokes a failed login before its HTTP error.
    h.events.emit("two", null, true);
    expect(h.session.snapshot().status).toBe("pending");
    if (mode === "canceled") h.session.cancel();
    if (mode === "disposed") h.session.dispose();
    h.events.emit("three", null);
    const error = "Builderlab code exchange failed with HTTP 503";
    response.resolve(Response.json({ error }, { status: 502 }));
    await pending;
    expect(h.session.snapshot()).toEqual({
      status: "signed-out",
      ...(mode === "current" ? { error } : {}),
    });
    h.session.dispose();
  },
);

it("ignores an older login error while preserving a replacement attempt's failure", async () => {
  const h = setup();
  h.events.emit("one", null);
  const oldResponse = deferred<Response>();
  const newResponse = deferred<Response>();
  h.fetch.mockImplementationOnce(() => oldResponse.promise);
  const oldLogin = h.session.signIn();
  h.events.emit("two", null, true);
  h.events.emit("three", null);
  h.fetch.mockImplementationOnce(() => newResponse.promise);
  const newLogin = h.session.signIn();
  h.events.emit("four", null, true);
  try {
    oldResponse.resolve(
      Response.json({ error: "Old login failed" }, { status: 502 }),
    );
    await oldLogin;
    expect(h.session.snapshot()).toEqual({ status: "pending" });
    h.events.emit("five", null);
  } finally {
    newResponse.resolve(
      Response.json({ error: "New login failed" }, { status: 502 }),
    );
  }
  await newLogin;
  expect(h.session.snapshot()).toEqual({
    status: "signed-out",
    error: "New login failed",
  });
  h.session.dispose();
});

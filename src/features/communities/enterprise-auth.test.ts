import { afterEach, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { flush } from "../relay/testing";
import { noteEnterpriseDenial } from "../relay/enterprise-sign-in";
import type { ReadTransport } from "../relay/transport";
import { createCommunities, EnterpriseLoginRequired } from "./service";
import type { EnterpriseAuth, EnterpriseAuthClient } from "./enterpriseAuthApi";

const viewer = "a".repeat(64);
const transport: ReadTransport = {
  viewer,
  relayAuthor: "b".repeat(64),
  query: async () => [],
  media: () => undefined,
};
const roots: Context[] = [];

function setup(auth: EnterpriseAuthClient) {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const ctx = new Context();
  roots.push(ctx);
  const connect = vi.fn(async () => transport);
  const communities = createCommunities(
    ctx,
    false,
    undefined,
    "",
    undefined,
    Promise.resolve(viewer),
    connect,
    auth,
  );
  return { communities, connect };
}

function authFixture(required = true) {
  return {
    gate: vi.fn(async (_community: string) => required),
    get: vi.fn(async (): Promise<EnterpriseAuth | null> => null),
    start: vi.fn(async () => ({ expiresAt: "2030-01-01T00:00:00Z" })),
    cancel: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  } satisfies EnterpriseAuthClient;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps ordinary communities on the existing connection path", async () => {
  const auth = authFixture(false);
  const { communities, connect } = setup(auth);
  await flush();
  communities.joined(
    { id: "https://ordinary.test", name: "Ordinary" },
    {
      name: "Local",
      picture: "",
    },
  );
  await flush();
  expect(auth.get).not.toHaveBeenCalled();
  expect(connect).toHaveBeenCalled();
  expect(communities.snapshot().enterprise).toBeUndefined();
});

it("stops a selected startup at an explicit enterprise sign-in gate", async () => {
  const auth = authFixture();
  const { communities, connect } = setup(auth);
  await flush();
  communities.joined(
    { id: "https://enterprise.test", name: "Enterprise" },
    {
      name: "Local",
      picture: "",
    },
  );
  await flush();
  expect(connect).not.toHaveBeenCalled();
  expect(communities.snapshot().enterprise).toMatchObject({
    communityId: "https://enterprise.test",
    status: "required",
  });
});

it("retries the same community after a completed browser login", async () => {
  const auth = authFixture();
  auth.get
    .mockResolvedValueOnce(null)
    .mockResolvedValue({ expiresAt: "2030-01-01T00:00:00Z" });
  const { communities, connect } = setup(auth);
  await flush();
  communities.joined(
    { id: "https://enterprise.test", name: "Enterprise" },
    {
      name: "Local",
      picture: "",
    },
  );
  await flush();
  await communities.startEnterpriseLogin();
  await flush();
  expect(auth.start).toHaveBeenCalledWith(expect.any(String));
  expect(auth.cancel).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
  expect(communities.snapshot().enterprise).toBeUndefined();
});

it("fences a canceled browser result so it cannot acquire a session", async () => {
  const auth = authFixture();
  let complete!: (value: { expiresAt: string }) => void;
  auth.start.mockImplementation(
    () => new Promise((resolve) => (complete = resolve)),
  );
  const { communities, connect } = setup(auth);
  await flush();
  communities.joined(
    { id: "https://enterprise.test", name: "Enterprise" },
    {
      name: "Local",
      picture: "",
    },
  );
  await flush();
  void communities.startEnterpriseLogin();
  await flush();
  communities.cancelEnterpriseLogin();
  complete({ expiresAt: "2030-01-01T00:00:00Z" });
  await flush();
  expect(auth.cancel).toHaveBeenCalledWith(expect.any(String));
  expect(connect).not.toHaveBeenCalled();
  expect(communities.snapshot().enterprise).toMatchObject({
    communityId: "https://enterprise.test",
    status: "required",
  });
});

it("does not let another owner dismiss an active browser attempt", async () => {
  const auth = authFixture();
  const login = deferred<{ expiresAt: string }>();
  auth.start.mockReturnValue(login.promise);
  const { communities } = setup(auth);
  await flush();
  const community = "https://enterprise.test";
  communities.joined(
    { id: community, name: "Enterprise" },
    { name: "Local", picture: "" },
  );
  await flush();
  const starting = communities.startEnterpriseLogin(community, "owner-a");
  await vi.waitFor(() => expect(auth.start).toHaveBeenCalledOnce());

  communities.dismissEnterpriseLogin(community, "owner-b");
  await communities.cancelEnterpriseLogin(community, "owner-b");
  expect(auth.cancel).not.toHaveBeenCalled();
  expect(communities.snapshot().enterprise).toMatchObject({
    communityId: community,
    status: "opening",
  });

  await communities.cancelEnterpriseLogin(community, "owner-a");
  expect(auth.cancel).toHaveBeenCalledOnce();
  login.resolve({ expiresAt: "2030-01-01T00:00:00Z" });
  await starting;
  expect(communities.snapshot().enterprise).toMatchObject({
    communityId: community,
    status: "required",
  });
});

it("ignores a gate result retired by switching communities", async () => {
  const auth = authFixture();
  let release!: (required: boolean) => void;
  auth.gate.mockImplementation((community: string) =>
    community === "https://first.test"
      ? new Promise<boolean>((resolve) => {
          release = resolve;
        })
      : Promise.resolve(true),
  );
  const { communities } = setup(auth);
  await flush();
  communities.joined(
    { id: "https://first.test", name: "First" },
    { name: "Local", picture: "" },
  );
  await flush();
  communities.joined(
    { id: "https://second.test", name: "Second" },
    { name: "Local", picture: "" },
  );
  await flush();
  expect(communities.snapshot().enterprise).toMatchObject({
    communityId: "https://second.test",
    status: "required",
  });
  release(true);
  await flush();
  expect(communities.snapshot().enterprise).toMatchObject({
    communityId: "https://second.test",
    status: "required",
  });
});

it("restarts a session after switching away and back while its gate is pending", async () => {
  const auth = authFixture(false);
  let releaseOld!: (required: boolean) => void;
  let firstGate = true;
  auth.gate.mockImplementation((community) => {
    if (community !== "https://first.test") return Promise.resolve(false);
    if (firstGate) {
      firstGate = false;
      return new Promise<boolean>((resolve) => {
        releaseOld = resolve;
      });
    }
    return Promise.resolve(false);
  });
  const { communities, connect } = setup(auth);
  await flush();
  communities.joined(
    { id: "https://first.test", name: "First" },
    { name: "Local", picture: "" },
  );
  await flush();
  communities.joined(
    { id: "https://second.test", name: "Second" },
    { name: "Local", picture: "" },
  );
  await flush();
  communities.select("https://first.test");
  await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
  releaseOld(true);
  await flush();
  expect(communities.snapshot().enterprise).toBeUndefined();
});

it("does not abort an ordinary connection when another gate is pending", async () => {
  const auth = authFixture();
  let release!: (required: boolean) => void;
  auth.gate.mockImplementation((community) =>
    community === "https://enterprise.test"
      ? new Promise<boolean>((resolve) => {
          release = resolve;
        })
      : Promise.resolve(false),
  );
  const { communities, connect } = setup(auth);
  await flush();
  const enterprise = communities.connect(
    "https://enterprise.test",
    new AbortController().signal,
  );
  await expect(
    communities.connect("https://ordinary.test", new AbortController().signal),
  ).resolves.toBe(transport);
  expect(connect).toHaveBeenCalledOnce();
  release(true);
  await expect(enterprise).rejects.toBeInstanceOf(EnterpriseLoginRequired);
});

it("keeps concurrent ordinary community connections independent", async () => {
  const auth = authFixture(false);
  const { communities, connect } = setup(auth);
  await flush();
  await expect(
    Promise.all([
      communities.connect(
        "https://first-ordinary.test",
        new AbortController().signal,
      ),
      communities.connect(
        "https://second-ordinary.test",
        new AbortController().signal,
      ),
    ]),
  ).resolves.toEqual([transport, transport]);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(communities.snapshot().enterprise).toBeUndefined();
});

it("allows concurrent ordinary checks for the same community", async () => {
  const auth = authFixture(false);
  const gate = deferred<boolean>();
  auth.gate.mockReturnValue(gate.promise);
  const { communities, connect } = setup(auth);
  await flush();
  const community = "https://ordinary.test";
  const first = communities.connect(community, new AbortController().signal);
  const second = communities.connect(community, new AbortController().signal);

  await vi.waitFor(() => expect(auth.gate).toHaveBeenCalledTimes(2));
  gate.resolve(false);
  await expect(Promise.all([first, second])).resolves.toEqual([
    transport,
    transport,
  ]);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(communities.snapshot().enterprise).toBeUndefined();
});

it("allows concurrent authenticated checks for the same required community", async () => {
  const auth = authFixture();
  const saved = deferred<EnterpriseAuth | null>();
  auth.get.mockReturnValue(saved.promise);
  const { communities, connect } = setup(auth);
  await flush();
  const community = "https://enterprise.test";
  const first = communities.connect(community, new AbortController().signal);
  const second = communities.connect(community, new AbortController().signal);

  await vi.waitFor(() => expect(auth.get).toHaveBeenCalledTimes(2));
  saved.resolve({ expiresAt: "2030-01-01T00:00:00Z" });
  await expect(Promise.all([first, second])).resolves.toEqual([
    transport,
    transport,
  ]);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(communities.snapshot().enterprise).toBeUndefined();
});

it("keeps a retained reconnect independent from a direct profile connection", async () => {
  const auth = authFixture(false);
  const { communities, connect } = setup(auth);
  await flush();
  const community = "https://ordinary.test";
  communities.joined(
    { id: community, name: "Ordinary" },
    { name: "Local", picture: "" },
  );
  await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());

  const gate = deferred<boolean>();
  auth.gate.mockClear();
  auth.gate.mockReturnValue(gate.promise);
  communities.relay.disconnect();
  communities.select(community);
  const profileConnection = communities.connect(
    community,
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(auth.gate).toHaveBeenCalledTimes(2));
  const reconnect = vi.waitFor(() =>
    expect(communities.relay.snapshot().status).toBe("ready"),
  );

  gate.resolve(false);
  await expect(profileConnection).resolves.toBe(transport);
  await reconnect;
  expect(communities.relay.snapshot().status).toBe("ready");
  expect(connect).toHaveBeenCalledTimes(3);
  expect(communities.snapshot().enterprise).toBeUndefined();
});

it("retains healthy sessions across selection without reconnecting on return", async () => {
  const auth = authFixture(false);
  const { communities, connect } = setup(auth);
  await flush();
  communities.joined(
    { id: "https://first-ordinary.test", name: "First" },
    { name: "Local", picture: "" },
  );
  await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
  await flush();
  communities.joined(
    { id: "https://second-ordinary.test", name: "Second" },
    { name: "Local", picture: "" },
  );
  await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
  await flush();

  communities.joined(
    { id: "https://first-ordinary.test", name: "First" },
    { name: "Local", picture: "" },
  );
  communities.select("https://first-ordinary.test");
  communities.select("https://second-ordinary.test");
  communities.select("https://first-ordinary.test");
  await flush();

  expect(connect).toHaveBeenCalledTimes(2);
});

it("cancels an enterprise attempt when joining another community", async () => {
  const auth = authFixture();
  auth.gate.mockImplementation((community) =>
    community === "https://enterprise.test"
      ? Promise.resolve(true)
      : Promise.resolve(false),
  );
  const login = deferred<{ expiresAt: string }>();
  auth.start.mockReturnValue(login.promise);
  const { communities, connect } = setup(auth);
  await flush();
  communities.joined(
    { id: "https://enterprise.test", name: "Enterprise" },
    { name: "Local", picture: "" },
  );
  await vi.waitFor(() =>
    expect(communities.snapshot().enterprise).toMatchObject({
      communityId: "https://enterprise.test",
      status: "required",
    }),
  );
  const starting = communities.startEnterpriseLogin();
  await vi.waitFor(() => expect(auth.start).toHaveBeenCalledOnce());

  communities.joined(
    { id: "https://ordinary.test", name: "Ordinary" },
    { name: "Local", picture: "" },
  );
  await vi.waitFor(() =>
    expect(auth.cancel).toHaveBeenCalledWith(expect.any(String)),
  );
  await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
  login.resolve({ expiresAt: "2030-01-01T00:00:00Z" });
  await starting;
});

it("retires a stale prompt without aborting a valid connection", async () => {
  const auth = authFixture();
  const stale = deferred<EnterpriseAuth | null>();
  auth.get
    .mockResolvedValueOnce(null)
    .mockReturnValueOnce(stale.promise)
    .mockResolvedValue({ expiresAt: "2030-01-01T00:00:00Z" });
  const login = deferred<{ expiresAt: string }>();
  auth.start.mockReturnValue(login.promise);
  const { communities, connect } = setup(auth);
  await flush();
  communities.joined(
    { id: "https://enterprise.test", name: "Enterprise" },
    { name: "Local", picture: "" },
  );
  await vi.waitFor(() =>
    expect(communities.snapshot().enterprise).toMatchObject({
      status: "required",
    }),
  );

  const pending = communities.connect(
    "https://enterprise.test",
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(auth.get).toHaveBeenCalledTimes(2));
  const starting = communities.startEnterpriseLogin();
  await vi.waitFor(() => expect(auth.start).toHaveBeenCalledOnce());
  login.resolve({ expiresAt: "2030-01-01T00:00:00Z" });
  await starting;
  await vi.waitFor(() =>
    expect(communities.snapshot().enterprise).toBeUndefined(),
  );

  stale.resolve({ expiresAt: "2030-01-01T00:00:00Z" });
  await expect(pending).resolves.toBe(transport);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(communities.snapshot().enterprise).toBeUndefined();
});

it("does not let a check that began before clear reconnect after clear", async () => {
  const auth = authFixture();
  const gate = deferred<boolean>();
  auth.gate.mockReturnValue(gate.promise);
  const { communities, connect } = setup(auth);
  await flush();
  const pending = communities.connect(
    "https://enterprise.test",
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(auth.gate).toHaveBeenCalledOnce());

  await communities.clearEnterpriseAuth();
  gate.resolve(true);
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(connect).not.toHaveBeenCalled();
  expect(communities.snapshot().enterprise).toBeUndefined();
});

it("does not fence an ordinary check during enterprise clear", async () => {
  const auth = authFixture(false);
  const gate = deferred<boolean>();
  const clearing = deferred<void>();
  auth.gate.mockReturnValue(gate.promise);
  auth.clear.mockReturnValue(clearing.promise);
  const { communities, connect } = setup(auth);
  await flush();
  const pending = communities.connect(
    "https://ordinary.test",
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(auth.gate).toHaveBeenCalledOnce());

  const clear = communities.clearEnterpriseAuth();
  await vi.waitFor(() => expect(auth.clear).toHaveBeenCalledOnce());
  gate.resolve(false);
  await expect(pending).resolves.toBe(transport);
  expect(connect).toHaveBeenCalledOnce();
  clearing.resolve();
  await clear;
});

it("rejects direct connections after disposal", async () => {
  const auth = authFixture(false);
  const { communities, connect } = setup(auth);
  await flush();
  const root = roots.at(-1);
  if (!root) throw new Error("missing test root");
  await root.fiber.dispose();

  await expect(
    communities.connect("https://ordinary.test", new AbortController().signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(connect).not.toHaveBeenCalled();
});

it("classifies discovery failure separately and retries the check", async () => {
  const auth = authFixture();
  auth.gate.mockRejectedValueOnce(new Error("advertisement unavailable"));
  auth.gate.mockResolvedValueOnce(false);
  const { communities, connect } = setup(auth);
  await flush();
  await expect(
    communities.connect("https://ordinary.test", new AbortController().signal),
  ).rejects.toMatchObject({ name: "EnterpriseDiscoveryError" });
  expect(communities.snapshot().enterprise).toMatchObject({
    status: "error",
    errorKind: "discovery",
  });
  await communities.retryEnterpriseGate("https://ordinary.test");
  expect(connect).not.toHaveBeenCalled();
  expect(communities.snapshot().enterprise).toBeUndefined();
  expect(auth.start).not.toHaveBeenCalled();
  auth.gate.mockResolvedValue(false);
  await expect(
    communities.connect("https://ordinary.test", new AbortController().signal),
  ).resolves.toBe(transport);
  expect(connect).toHaveBeenCalledOnce();
  auth.gate.mockResolvedValueOnce(true);
  await expect(
    communities.connect(
      "https://required-after-recovery.test",
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(EnterpriseLoginRequired);
  expect(communities.snapshot().enterprise).toMatchObject({
    communityId: "https://required-after-recovery.test",
    status: "required",
  });
});

it("cancels an owned browser attempt when the service is disposed", async () => {
  const auth = authFixture();
  let finish!: (value: { expiresAt: string }) => void;
  auth.start.mockImplementation(
    () => new Promise((resolve) => (finish = resolve)),
  );
  const { communities } = setup(auth);
  await flush();
  communities.joined(
    { id: "https://enterprise.test", name: "Enterprise" },
    { name: "Local", picture: "" },
  );
  await flush();
  void communities.startEnterpriseLogin();
  await flush();
  const root = roots.at(-1);
  if (!root) throw new Error("missing test root");
  await root.fiber.dispose();
  expect(auth.cancel).toHaveBeenCalledWith(expect.any(String));
  finish({ expiresAt: "2030-01-01T00:00:00Z" });
});

it("keeps an opening attempt visible when a duplicate gate also requires login", async () => {
  const auth = authFixture();
  let finish!: (value: { expiresAt: string }) => void;
  auth.start.mockImplementation(
    () => new Promise((resolve) => (finish = resolve)),
  );
  const { communities } = setup(auth);
  await flush();
  communities.joined(
    { id: "https://enterprise.test", name: "Enterprise" },
    { name: "Local", picture: "" },
  );
  await flush();
  void communities.startEnterpriseLogin();
  await flush();
  await expect(
    communities.connect(
      "https://enterprise.test",
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(EnterpriseLoginRequired);
  expect(communities.snapshot().enterprise).toMatchObject({
    communityId: "https://enterprise.test",
    status: "opening",
  });
  finish({ expiresAt: "2030-01-01T00:00:00Z" });
});

it("clears only the shared enterprise session and requires a fresh login", async () => {
  const auth = authFixture();
  const { communities, connect } = setup(auth);
  await flush();
  communities.joined(
    { id: "https://enterprise.test", name: "Enterprise" },
    { name: "Local", picture: "" },
  );
  await flush();
  const before = communities.snapshot();
  await communities.clearEnterpriseAuth();
  await flush();
  expect(auth.clear).toHaveBeenCalledOnce();
  expect(communities.snapshot()).toMatchObject({
    viewer,
    profile: before.profile,
    memberships: before.memberships,
    selected: before.selected,
  });
  expect(connect).not.toHaveBeenCalled();
  expect(communities.snapshot().enterprise).toMatchObject({
    communityId: "https://enterprise.test",
    status: "required",
  });
});

it("releases an active enterprise session before retrying after clear", async () => {
  const auth = authFixture();
  auth.get.mockResolvedValue({ expiresAt: "2030-01-01T00:00:00Z" });
  const { communities, connect } = setup(auth);
  await flush();
  communities.joined(
    { id: "https://enterprise.test", name: "Enterprise" },
    { name: "Local", picture: "" },
  );
  await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
  await flush();

  await communities.clearEnterpriseAuth();
  await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
  expect(auth.clear).toHaveBeenCalledOnce();
  expect(communities.snapshot().enterprise).toBeUndefined();
});

it("disconnects enterprise sessions after a failed clear but keeps ordinary sessions", async () => {
  const auth = authFixture();
  const enterprise = "https://enterprise.test";
  const ordinary = "https://ordinary.test";
  auth.gate.mockImplementation(async (community) => community === enterprise);
  auth.get.mockResolvedValue({ expiresAt: "2030-01-01T00:00:00Z" });
  auth.clear.mockRejectedValue(new Error("Secure storage unavailable"));
  const { communities, connect } = setup(auth);
  await flush();

  communities.joined(
    { id: ordinary, name: "Ordinary" },
    { name: "Local", picture: "" },
  );
  await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
  communities.joined(
    { id: enterprise, name: "Enterprise" },
    { name: "Local", picture: "" },
  );
  await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
  expect(communities.relay.snapshot().status).toBe("ready");

  await expect(communities.clearEnterpriseAuth()).rejects.toThrow(
    "Secure storage unavailable",
  );
  expect(communities.relay.snapshot().status).toBe("disconnected");
  expect(connect).toHaveBeenCalledTimes(2);

  communities.select(ordinary);
  expect(communities.relay.snapshot().status).toBe("ready");
});

it("a relay session denial clears enterprise sign-in and prompts again", async () => {
  const auth = authFixture();
  auth.get.mockResolvedValue({ expiresAt: "2030-01-01T00:00:00Z" });
  const { communities, connect } = setup(auth);
  await flush();
  communities.joined(
    { id: "https://enterprise.test", name: "Enterprise" },
    { name: "Local", picture: "" },
  );
  await flush();
  expect(connect).toHaveBeenCalled();
  auth.get.mockResolvedValue(null);
  noteEnterpriseDenial(
    new Error("Relay badge was refused (401 invalid_proof)"),
  );
  await flush();
  expect(auth.clear).not.toHaveBeenCalled();
  noteEnterpriseDenial(new Error("Enterprise sign-in is required"));
  await flush();
  expect(auth.clear).toHaveBeenCalledOnce();
  expect(communities.snapshot().enterprise).toMatchObject({
    communityId: "https://enterprise.test",
    status: "required",
  });
});

import { Context } from "@deepseek-ai/cordis";
import { assert, afterEach, expect, it, vi } from "vitest";
import { createCommunities } from "./service";
import { communityDestination } from "./destination";
import * as destinations from "./destination";
import { flush } from "../relay/testing";
import { readView, writeView } from "../../shared/view-state";

const viewer = "a".repeat(64);
const roots: Context[] = [];
const requests: string[] = [];
function setup(saved?: unknown, savedViewer = viewer, extraIdentity = {}) {
  const storage = new Map<string, string>();
  if (saved)
    storage.set(`buzz-client.v1:${savedViewer}`, JSON.stringify(saved));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      requests.push(input);
      if (input.endsWith("/identity"))
        return Response.json({ viewer, ...extraIdentity });
      if (input.endsWith("/session")) {
        const destination = input.split("/")[3];
        assert.exists(destination);
        return Response.json({
          viewer,
          relayAuthor: "b".repeat(64),
          relayUrl: communityDestination(decodeURIComponent(destination)).url,
        });
      }
      return Response.json([]);
    }),
  );
  const ctx = new Context();
  roots.push(ctx);
  return createCommunities(ctx, true);
}
afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose();
  requests.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("opens an identity without touching a community and saves a local profile independently", async () => {
  const client = setup();
  await flush();
  expect(client.snapshot()).toMatchObject({
    status: "ready",
    memberships: [],
    selected: null,
  });
  expect(requests).toEqual(["/api/relay/identity"]);
  client.saveProfile({ name: "Local name", picture: "" });
  expect(client.snapshot().profile.name).toBe("Local name");
  expect(requests).toHaveLength(1);
});
it("retains separate sessions on A→B→A, and personal space does not reset them", async () => {
  const client = setup();
  await flush();
  client.joined(
    { id: "primary", name: "Primary" },
    { name: "Local", picture: "" },
  );
  await flush();
  const a = client.relay.snapshot();
  client.joined(
    { id: "secondary", name: "Secondary" },
    { name: "Different", picture: "" },
  );
  await flush();
  const b = client.relay.snapshot();
  expect(a.session).not.toBe(b.session);
  expect(a.scope).not.toBe(b.scope);
  client.select(null);
  expect(client.relay.snapshot().status).toBe("disconnected");
  client.select("primary");
  expect(client.relay.snapshot()).toBe(a);
  client.select("secondary");
  expect(client.relay.snapshot()).toBe(b);
  expect(client.snapshot().profile.name).toBe("Local");
  expect(requests.filter((url) => url.endsWith("/session"))).toHaveLength(2);
});
it("does not reuse another identity's memberships; draft and view keys include community and identity", async () => {
  const client = setup(
    {
      profile: { name: "Someone else", picture: "" },
      memberships: [{ id: "primary", name: "Primary" }],
      selected: "primary",
    },
    "c".repeat(64),
  );
  await flush();
  expect(client.snapshot().memberships).toEqual([]);
  expect(client.snapshot().profile.name).toBe("");
  writeView("community-a:identity-a", "draft:same-channel", "draft A");
  writeView("community-b:identity-a", "draft:same-channel", "draft B");
  expect(readView("community-a:identity-a", "draft:same-channel", "")).toBe(
    "draft A",
  );
  expect(readView("community-b:identity-a", "draft:same-channel", "")).toBe(
    "draft B",
  );
  expect(readView("community-a:identity-b", "draft:same-channel", "")).toBe("");
});
it("restores only the selected membership on launch", async () => {
  const client = setup({
    profile: { name: "Local", picture: "" },
    memberships: [
      { id: "primary", name: "Primary" },
      { id: "secondary", name: "Secondary" },
    ],
    selected: "secondary",
  });
  await flush();
  await flush();
  expect(client.snapshot().selected).toBe("secondary");
  expect(requests.filter((url) => url.endsWith("/session"))).toEqual([
    "/api/relay/secondary/session",
  ]);
});

it("a failing community does not replace its healthy sibling or the local profile", async () => {
  const client = setup();
  await flush();
  client.joined(
    { id: "primary", name: "Primary" },
    { name: "Local", picture: "" },
  );
  await flush();
  const healthy = client.relay.snapshot();
  vi.mocked(fetch).mockImplementationOnce(async () =>
    Response.json({ error: "Unavailable" }, { status: 503 }),
  );
  client.joined(
    { id: "secondary", name: "Secondary" },
    { name: "Community", picture: "" },
  );
  await flush();
  expect(client.relay.snapshot().status).toBe("error");
  expect(client.snapshot().profile.name).toBe("Local");
  client.select("primary");
  expect(client.relay.snapshot()).toBe(healthy);
});

it("keeps local actions and completed joins usable when storage writes fail", async () => {
  const client = setup();
  await flush();
  vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new Error("Storage quota exceeded");
  });
  client.saveProfile({ name: "Local", picture: "" });
  client.joined(
    { id: "primary", name: "Primary" },
    { name: "Remote", picture: "" },
  );
  await flush();
  expect(client.snapshot()).toMatchObject({
    profile: { name: "Local" },
    selected: "primary",
    memberships: [{ id: "primary" }],
  });
  expect(client.relay.snapshot().status).toBe("ready");
  client.select(null);
  expect(client.snapshot().selected).toBeNull();
});

it("ignores invalid and duplicate memberships without discarding a valid local profile", async () => {
  const client = setup({
    profile: { name: "Local", picture: "" },
    memberships: [
      null,
      { id: "primary", name: "Primary" },
      { id: "primary", name: "Duplicate" },
      { id: "secondary", name: "Secondary" },
    ],
    selected: "secondary",
  });
  await flush();
  expect(client.snapshot().profile.name).toBe("Local");
  expect(client.snapshot().memberships.map((m) => m.id)).toEqual([
    "primary",
    "secondary",
  ]);
  expect(client.snapshot().selected).toBe("secondary");
});

it("persists arbitrary canonical origins, preserves legacy aliases, and restores only the selected one", async () => {
  const client = setup();
  await flush();
  for (const id of [
    "primary",
    "wss://THIRD.example:443/",
    "https://fourth.example",
    "wss://fifth.example:8443",
  ]) {
    client.joined({ id, name: id }, { name: "Local", picture: "" });
    await flush();
  }
  client.joined(
    { id: "https://third.example/", name: "Third renamed" },
    { name: "Other", picture: "" },
  );
  await flush();
  expect(client.snapshot().memberships).toHaveLength(4);
  expect(client.snapshot().selected).toBe("https://third.example");
  expect(client.relay.snapshot().scope).toContain("https://third.example");
  const persisted = localStorage.getItem(`buzz-client.v1:${viewer}`);
  assert.exists(persisted);
  const saved = JSON.parse(persisted);
  requests.length = 0;
  const restored = setup(saved);
  await flush();
  await flush();
  expect(restored.snapshot()).toMatchObject({ ...saved, status: "ready" });
  expect(requests.filter((url) => url.endsWith("/session"))).toEqual([
    "/api/relay/https%3A%2F%2Fthird.example/session",
  ]);
  expect(requests.indexOf("/api/relay/register")).toBeLessThan(
    requests.indexOf("/api/relay/https%3A%2F%2Fthird.example/session"),
  );
});

it("normalizes old and new stored spellings without duplicates or unsafe automatic connections", async () => {
  const client = setup({
    profile: { name: "Local", picture: "" },
    memberships: [
      { id: "primary", name: "Primary" },
      { id: "WSS://PRIMARY.EXAMPLE:443/", name: "Duplicate" },
      { id: "wss://THIRD.example/", name: "Third" },
      { id: "https://third.example", name: "Duplicate third" },
      { id: "http://unsafe.example", name: "Unsafe" },
      { id: "https://user:secret@unsafe.example", name: "Credentials" },
    ],
    selected: "wss://THIRD.example:443/",
  });
  await flush();
  await flush();
  expect(client.snapshot().memberships.map((m) => m.id)).toEqual([
    "primary",
    "https://third.example",
  ]);
  expect(client.snapshot().selected).toBe("https://third.example");
  expect(requests.filter((url) => url.endsWith("/session"))).toEqual([
    "/api/relay/https%3A%2F%2Fthird.example/session",
  ]);
  const before = client.snapshot();
  expect(() =>
    client.joined(
      { id: "https://bad.example/path", name: "Bad" },
      { name: "Other", picture: "" },
    ),
  ).toThrow();
  expect(client.snapshot()).toBe(before);
});

it("does not acquire a session after rejected registration and registers again on retry", async () => {
  const client = setup();
  await flush();
  vi.mocked(fetch).mockImplementationOnce(async () =>
    Response.json({ error: "Registration rejected" }, { status: 403 }),
  );
  client.joined(
    { id: "wss://third.example", name: "Third" },
    { name: "Local", picture: "" },
  );
  await flush();
  expect(client.relay.snapshot().status).toBe("error");
  expect(requests.filter((url) => url.endsWith("/session"))).toHaveLength(0);
  client.relay.retry();
  await flush();
  await flush();
  expect(client.relay.snapshot().status).toBe("ready");
  expect(
    requests.filter(
      (url) => url.endsWith("/register") || url.endsWith("/session"),
    ),
  ).toEqual([
    "/api/relay/register",
    "/api/relay/https%3A%2F%2Fthird.example/session",
  ]);
});

it("selects alternate URL spellings through the canonical retained session", async () => {
  const client = setup();
  await flush();
  client.joined(
    { id: "wss://third.example", name: "Third" },
    { name: "Local", picture: "" },
  );
  await flush();
  await flush();
  const original = client.relay.snapshot();
  const connections = requests.filter((url) => url.endsWith("/session")).length;
  client.select(null);
  client.select(" WSS://THIRD.example:443/ ");
  expect(client.snapshot().selected).toBe("https://third.example");
  expect(client.relay.snapshot()).toBe(original);
  expect(requests.filter((url) => url.endsWith("/session"))).toHaveLength(
    connections,
  );
});

it("preserves unresolved saved aliases across profile saves and reloads without connecting", async () => {
  const membership = {
    id: "unconfigured-old",
    name: "Saved community",
    icon: "https://images.example/icon.png",
  };
  const saved = {
    profile: { name: "Before", picture: "" },
    memberships: [membership],
    selected: membership.id,
  };
  const client = setup(saved);
  await flush();
  expect(client.snapshot()).toMatchObject({
    status: "ready",
    memberships: [],
    selected: null,
  });
  expect(requests).toEqual(["/api/relay/identity"]);
  expect(() => client.select(membership.id)).toThrow();
  client.saveProfile({ name: "After", picture: "" });
  const persisted = JSON.parse(
    localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null",
  );
  expect(persisted).toEqual({
    ...saved,
    profile: { name: "After", picture: "" },
  });
  const reloaded = setup(persisted);
  await flush();
  reloaded.saveProfile({ name: "After reload", picture: "" });
  const again = JSON.parse(
    localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null",
  );
  expect(again.memberships).toEqual([membership]);
  expect(again.selected).toBe(membership.id);
  expect(requests).toEqual(["/api/relay/identity", "/api/relay/identity"]);
  // Model a restart with the original deployment mapping restored.
  const resolve = destinations.communityDestination;
  const aliases = destinations.parseCommunityAliases(
    '{"unconfigured-old":"https://restored.example"}',
  );
  vi.spyOn(destinations, "communityDestination").mockImplementation((value) =>
    resolve(value, aliases),
  );
  const restored = setup(again);
  await flush();
  expect(restored.snapshot()).toMatchObject({
    memberships: [membership],
    selected: membership.id,
  });
  expect(requests.filter((url) => url.endsWith("/session"))).toEqual([
    "/api/relay/unconfigured-old/session",
  ]);
  expect(restored.relay.snapshot().scope).toBe(
    `https://restored.example:${viewer}`,
  );
});

it("retains unresolved memberships but honors an explicit Personal selection or a new join", async () => {
  const membership = { id: "unconfigured-old", name: "Saved community" };
  const client = setup({
    profile: { name: "Before", picture: "" },
    memberships: [membership],
    selected: membership.id,
  });
  await flush();
  client.select(null);
  let persisted = JSON.parse(
    localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null",
  );
  expect(persisted.memberships).toEqual([membership]);
  expect(persisted.selected).toBeNull();
  client.joined(
    { id: "primary", name: "New community" },
    { name: "After", picture: "" },
  );
  await flush();
  persisted = JSON.parse(
    localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null",
  );
  expect(persisted.memberships).toEqual([
    { id: "primary", name: "New community" },
    membership,
  ]);
  expect(persisted.selected).toBe("primary");
  expect(requests.some((url) => url.includes("unconfigured-old"))).toBe(false);
});

it("keeps only valid unique unresolved aliases and never carries them to another identity", async () => {
  const saved = {
    profile: { name: "Before", picture: "" },
    memberships: [
      { id: "unconfigured-old", name: "Saved" },
      { id: "unconfigured-old", name: "Duplicate" },
      { id: "bad/id", name: "Invalid" },
      { id: "https://user:secret@private.example", name: "Invalid" },
      { id: "constructor", name: "Invalid" },
      { id: "prototype", name: "Invalid" },
      { id: "__proto__", name: "Invalid" },
    ],
    selected: "constructor",
  };
  const client = setup(saved);
  await flush();
  client.saveProfile({ name: "After", picture: "" });
  const persisted = JSON.parse(
    localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null",
  );
  expect(persisted.memberships).toEqual([
    { id: "unconfigured-old", name: "Saved" },
  ]);
  expect(persisted.selected).toBeNull();
  const other = setup(saved, "c".repeat(64));
  await flush();
  other.saveProfile({ name: "Other", picture: "" });
  expect(
    JSON.parse(localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null")
      .memberships,
  ).toEqual([]);
});

const startupCommunity = {
  url: "https://remembered.example",
  name: "Remembered",
};
it("a fresh port inherits once without remote joins or preference writes", async () => {
  const client = setup(undefined, viewer, { startupCommunity });
  await flush();
  expect(client.snapshot()).toMatchObject({
    selected: startupCommunity.url,
    memberships: [{ id: startupCommunity.url, name: "Remembered" }],
  });
  expect(
    JSON.parse(localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null")
      .selected,
  ).toBe(startupCommunity.url);
  expect(requests.filter((url) => /preference|join|publish/.test(url))).toEqual(
    [],
  );
  client.select(null);
  await flush();
  expect(client.snapshot().selected).toBeNull();
  expect(
    requests.filter((url) => url.endsWith("community-preference")),
  ).toEqual([]);
});
it.each([null, "https://existing.example"])(
  "local selection %s overrides shared startup",
  async (selected) => {
    const client = setup(
      {
        profile: { name: "Mine", picture: "" },
        memberships: [{ id: "https://existing.example", name: "Existing" }],
        selected,
      },
      viewer,
      { startupCommunity },
    );
    await flush();
    expect(client.snapshot().selected).toBe(selected);
    expect(client.snapshot().profile.name).toBe("Mine");
    expect(requests.some((url) => url.includes("remembered.example"))).toBe(
      false,
    );
  },
);
it("an unavailable saved alias is not replaced by the shared preference", async () => {
  const client = setup(
    { memberships: [{ id: "missing", name: "Missing" }], selected: "missing" },
    viewer,
    { startupCommunity },
  );
  await flush();
  expect(client.snapshot().selected).toBeNull();
  expect(requests).toEqual(["/api/relay/identity"]);
});
it.each([
  null,
  { url: "http://unsafe.example", name: "No" },
  { url: "https://valid.example" },
])(
  "invalid or absent shared preference leaves Personal usable (%j)",
  async (startupCommunity) => {
    const client = setup(undefined, viewer, { startupCommunity });
    await flush();
    expect(client.snapshot()).toMatchObject({
      status: "ready",
      selected: null,
      memberships: [],
    });
  },
);
it("only explicit community choices update the shared preference, never profile saves or restore", async () => {
  const client = setup(
    { memberships: [{ id: "primary", name: "Primary" }], selected: "primary" },
    viewer,
    { startupCommunity: null },
  );
  await flush();
  expect(requests.some((url) => url.endsWith("community-preference"))).toBe(
    false,
  );
  client.saveProfile({ name: "Local", picture: "" });
  client.select("primary");
  await flush();
  const writes = vi
    .mocked(fetch)
    .mock.calls.filter(([url]) => url === "/api/relay/community-preference");
  expect(writes).toHaveLength(1);
  expect(JSON.parse(String(writes[0]?.[1]?.body))).toMatchObject({
    url: communityDestination("primary").url,
    name: "Primary",
    selectedAt: expect.any(Number),
  });
});
it("preference write failure does not prevent switching or later writes", async () => {
  const client = setup(
    { memberships: [{ id: "primary", name: "Primary" }], selected: null },
    viewer,
    { startupCommunity: null },
  );
  await flush();
  const original = vi.mocked(fetch).getMockImplementation();
  vi.mocked(fetch).mockImplementation(async (...args) => {
    if (args[0] === "/api/relay/community-preference")
      throw new Error("disk unavailable");
    if (!original) throw new Error("Missing fetch fixture");
    return original(...args);
  });
  client.select("primary");
  await flush();
  expect(client.snapshot().selected).toBe("primary");
  client.select(null);
  client.select("primary");
  await flush();
  expect(
    vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => url === "/api/relay/community-preference"),
  ).toHaveLength(2);
});

it("malformed-but-present local state prevents shared inheritance", async () => {
  const client = setup(undefined, viewer, { startupCommunity });
  localStorage.setItem(`buzz-client.v1:${viewer}`, "broken json");
  await flush();
  expect(client.snapshot().selected).toBeNull();
  expect(requests).toEqual(["/api/relay/identity"]);
});

it("timestamps choices before a delayed registration across two windows", async () => {
  const saved = {
    memberships: [{ id: "primary", name: "Primary" }],
    selected: "primary",
  };
  const first = setup(saved, viewer, { startupCommunity: null });
  await flush();
  const second = setup(saved, viewer, { startupCommunity: null });
  await flush();
  const original = vi.mocked(fetch).getMockImplementation();
  const deferred = <T>() => {
    let resolve: (value: T | PromiseLike<T>) => void = () => {};
    const promise = new Promise<T>((accept) => {
      resolve = accept;
    });
    return { promise, resolve };
  };
  const gate = deferred<Response>();
  const started = deferred<void>();
  const persisted = deferred<void>();
  const timestamps: number[] = [];
  let hold = true;
  vi.mocked(fetch).mockImplementation(async (...args) => {
    if (args[0] === "/api/relay/register" && hold) {
      hold = false;
      started.resolve();
      return gate.promise;
    }
    if (args[0] === "/api/relay/community-preference") {
      timestamps.push(JSON.parse(String(args[1]?.body)).selectedAt);
      persisted.resolve();
      return Response.json({ saved: true });
    }
    if (!original) throw new Error("Missing fetch fixture");
    return original(...args);
  });
  const clock = vi.spyOn(performance, "now").mockReturnValue(100);
  first.select("primary");
  await started.promise;
  try {
    clock.mockReturnValue(200);
    second.select("primary");
    await persisted.promise;
    expect(timestamps).toHaveLength(1);
  } finally {
    gate.resolve(Response.json({}));
  }
  await flush();
  expect(timestamps).toHaveLength(2);
  expect(timestamps[1]).toBeLessThan(timestamps[0] ?? 0);
});

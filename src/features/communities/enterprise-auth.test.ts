import { afterEach, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { flush } from "../relay/testing";
import type { ReadTransport } from "../relay/transport";
import { createCommunities } from "./service";
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
  } satisfies EnterpriseAuthClient;
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

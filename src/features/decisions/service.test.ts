import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import { flush } from "../relay/testing";
import {
  COMMUNITY_DECISION_BACKENDS_KEY,
  DECISION_BACKEND_KEY,
  DECISIONS_OFF,
  DEFAULT_DECISION_PROVIDER,
  DecisionsService,
  type DecisionProvider,
  type DecisionProviderStatus,
  type DecisionRequest,
} from "./service";

const request: DecisionRequest = {
  state: "The build is broken on main.",
  questions: {
    urgent: { type: "yes_no", instructions: "It needs attention now." },
  },
};
const reply = {
  outcome: "answered" as const,
  model: "jev-1.13.0",
  answers: { urgent: { type: "yes_no" as const, probability: 0.8 } },
};
function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    values,
  } as unknown as Storage & { values: Map<string, string> };
}
/** A root whose plugins are all active, and its decisions service. */
function setup(storage: Storage = memory(), active = () => true) {
  const root = new Context();
  const listeners = new Set<() => void>();
  root.provide("pluginStatus", {
    isActive: () => active(),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const timers: { run(): void; ms: number }[] = [];
  const service = new DecisionsService(root, storage, (run, ms) => {
    const timer = { run, ms };
    timers.push(timer);
    return () => void timers.splice(timers.indexOf(timer), 1);
  });
  /** Registers `provider` from a plugin `id`; resolves to its fiber. */
  const plugin = async (id: string, provider: Partial<DecisionProvider>) => {
    const fiber = root
      .extend({ pluginOwner: { id, revision: "one" } })
      .plugin((ctx) => ctx.decisions.registerProvider(fake(provider)));
    await fiber.await();
    await flush();
    return fiber;
  };
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return { root, service, plugin, timers, changed };
}
function fake(provider: Partial<DecisionProvider>): DecisionProvider {
  return {
    id: "main",
    label: "Fake",
    description: "A test provider.",
    status: () => "ready",
    subscribe: () => () => {},
    decide: async () => reply,
    ...provider,
  };
}
/** A provider whose status the test sets. */
function settable(status: DecisionProviderStatus) {
  const listeners = new Set<() => void>();
  return {
    status: () => status,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set(next: DecisionProviderStatus) {
      status = next;
      for (const listener of listeners) listener();
    },
  };
}

it("is unavailable with no provider, and never rejects", async () => {
  const { service } = setup();
  expect(service.backend()).toBeUndefined();
  expect(service.status()).toBe("unavailable");
  await expect(service.decide(request)).resolves.toEqual({
    outcome: "failed",
    backend: undefined,
    reason: "unavailable",
  });
});

it("uses the default after a plugin retires its saved provider, including after reload", async () => {
  const storage = memory({ [DECISION_BACKEND_KEY]: "example.plugin/retired" });
  const f = setup(storage);
  const decide = vi.fn<DecisionProvider["decide"]>(async () => reply);
  await f.plugin("block.builderlab", { id: "builderlab", decide });
  expect(f.service.status()).toBe("unavailable");
  const listener = vi.fn();
  f.service.subscribe(listener);
  const fiber = f.root
    .extend({ pluginOwner: { id: "example.plugin", revision: "two" } })
    .plugin((ctx) => ctx.decisions.retireProvider("retired"));
  await fiber.await();
  expect(listener).toHaveBeenCalledOnce();
  await expect(f.service.decide(request)).resolves.toMatchObject({
    outcome: "answered",
    backend: "block.builderlab/builderlab",
  });
  expect(storage.getItem(DECISION_BACKEND_KEY)).toBeNull();
  const reload = setup(storage);
  await reload.plugin("block.builderlab", { id: "builderlab" });
  expect(reload.service.backend()).toBe("block.builderlab/builderlab");
  await f.root.fiber.dispose();
  await reload.root.fiber.dispose();
});

it.each([
  "example.other/retired",
  "example.plugin/current",
  "buzz.typesafe/typesafe",
])(
  "preserves the saved choice %s when a plugin retires another provider",
  async (chosen) => {
    const storage = memory({ [DECISION_BACKEND_KEY]: chosen });
    const { root } = setup(storage);
    const fiber = root
      .extend({ pluginOwner: { id: "example.plugin", revision: "two" } })
      .plugin((ctx) => ctx.decisions.retireProvider("retired"));
    await fiber.await();
    expect(storage.getItem(DECISION_BACKEND_KEY)).toBe(chosen);
    await root.fiber.dispose();
  },
);

it("keeps the saved provider when its retirement cannot be stored", async () => {
  const storage = memory({ [DECISION_BACKEND_KEY]: "example.plugin/retired" });
  storage.removeItem = () => {
    throw new Error("Storage unavailable");
  };
  const { root, service, plugin } = setup(storage);
  await plugin("example.plugin", { id: "retired" });
  const scoped = root.extend({
    pluginOwner: { id: "example.plugin", revision: "two" },
  });
  expect(() => scoped.decisions.retireProvider("retired")).toThrow(
    "Storage unavailable",
  );
  expect(service.backend()).toBe("example.plugin/retired");
  await root.fiber.dispose();
});

it("requires a plugin scope and a local provider ID for retirement", async () => {
  const { root, service } = setup();
  expect(() => service.retireProvider("retired")).toThrow(
    "Only an installed plugin",
  );
  const scoped = root.extend({
    pluginOwner: { id: "example.plugin", revision: "two" },
  });
  expect(() =>
    scoped.decisions.retireProvider("example.other/retired"),
  ).toThrow("Invalid decision provider ID");
  expect(() => scoped.decisions.retireProvider("")).toThrow(
    "Invalid decision provider ID",
  );
  await root.fiber.dispose();
});

it("asks the provider plugins register, through the injected ctx.decisions", async () => {
  const { service, plugin } = setup();
  const decide = vi.fn<DecisionProvider["decide"]>(async () => reply);
  const fiber = await plugin("buzz.typesafe", { id: "typesafe", decide });
  expect(service.providers().map((provider) => provider.key)).toEqual([
    "buzz.typesafe/typesafe",
  ]);
  expect(service.backend()).toBe("buzz.typesafe/typesafe");
  await expect(service.decide(request)).resolves.toEqual({
    ...reply,
    backend: "buzz.typesafe/typesafe",
  });
  // The deadline is filled in, and the provider is told when to stop.
  expect(decide).toHaveBeenCalledWith(
    { ...request, timeoutMs: 30_000 },
    { signal: expect.any(AbortSignal) },
  );
  // Disabling the plugin removes its provider.
  await fiber.dispose();
  expect(service.providers()).toEqual([]);
  expect(service.status()).toBe("unavailable");
});

it("lists only providers of active plugin revisions", async () => {
  let active = false;
  const { service, plugin, changed } = setup(memory(), () => active);
  await plugin("buzz.typesafe", {});
  expect(service.providers()).toEqual([]);
  active = true;
  changed();
  expect(service.providers()).toHaveLength(1);
});

it("uses TypeSafe until the user chooses, even when another provider is ready first", async () => {
  const storage = memory();
  const { service, plugin } = setup(storage);
  const typesafe = settable("needs-setup");
  // Sorts ahead of TypeSafe, by order and by key, and is ready.
  await plugin("acme.helper", { id: "p", order: -1 });
  await plugin("buzz.typesafe", { id: "typesafe", ...typesafe });
  expect(service.backend()).toBe(DEFAULT_DECISION_PROVIDER);
  expect(service.status()).toBe("needs-setup");
  const listener = vi.fn();
  // Unbound, as React's useSyncExternalStore calls it.
  const { subscribe } = service;
  subscribe(listener);
  typesafe.set("ready");
  expect(service.status()).toBe("ready");
  expect(listener).toHaveBeenCalled();
  await expect(service.decide(request)).resolves.toMatchObject({
    backend: DEFAULT_DECISION_PROVIDER,
  });
  // Only an explicit choice moves decisions to another provider.
  service.setBackend("acme.helper/p");
  expect(service.backend()).toBe("acme.helper/p");
  expect(storage.values.get(DECISION_BACKEND_KEY)).toBe("acme.helper/p");
  // A choice that is not a registered provider changes nothing.
  listener.mockClear();
  service.setBackend("other/main");
  expect(service.backend()).toBe("acme.helper/p");
  expect(listener).not.toHaveBeenCalled();
});

it("never sends decisions elsewhere while the chosen provider is missing", async () => {
  const decide = vi.fn<DecisionProvider["decide"]>(async () => reply);
  // The user chose TypeSafe, and its plugin is off or not registered yet.
  const { service, plugin } = setup(
    memory({ [DECISION_BACKEND_KEY]: DEFAULT_DECISION_PROVIDER }),
  );
  await plugin("zzz.other", { id: "p", decide });
  expect(service.backend()).toBeUndefined();
  expect(service.status()).toBe("unavailable");
  await expect(service.decide(request)).resolves.toEqual({
    outcome: "failed",
    backend: undefined,
    reason: "unavailable",
  });
  // With no choice, TypeSafe is the choice, so the same holds.
  const fresh = setup();
  await fresh.plugin("zzz.other", { id: "p", decide });
  expect(fresh.service.status()).toBe("unavailable");
  await expect(fresh.service.decide(request)).resolves.toMatchObject({
    reason: "unavailable",
  });
  expect(decide).not.toHaveBeenCalled();
});

it("uses Builderlab while it is registered, unless the user chose another", async () => {
  const storage = memory();
  const { service, plugin } = setup(storage);
  const typesafe = await plugin("buzz.typesafe", { id: "typesafe" });
  expect(service.backend()).toBe(DEFAULT_DECISION_PROVIDER);
  // Builderlab registers only for a signed-in account it allows.
  let builderlab = await plugin("block.builderlab", { id: "builderlab" });
  expect(service.backend()).toBe("block.builderlab/builderlab");
  await builderlab.dispose();
  expect(service.backend()).toBe(DEFAULT_DECISION_PROVIDER);
  // A chosen Builderlab that is missing leaves decisions unavailable: no
  // other provider answers in its place.
  builderlab = await plugin("block.builderlab", { id: "builderlab" });
  service.setBackend("block.builderlab/builderlab");
  await builderlab.dispose();
  expect(service.backend()).toBeUndefined();
  expect(service.status()).toBe("unavailable");
  // A chosen TypeSafe stays when Builderlab registers again, and is not
  // replaced by Builderlab while TypeSafe is off.
  service.setBackend(DEFAULT_DECISION_PROVIDER);
  builderlab = await plugin("block.builderlab", { id: "builderlab" });
  expect(service.backend()).toBe(DEFAULT_DECISION_PROVIDER);
  await typesafe.dispose();
  expect(service.backend()).toBeUndefined();
  expect(storage.values.get(DECISION_BACKEND_KEY)).toBe(
    DEFAULT_DECISION_PROVIDER,
  );
});

it("routes to the first default offered, whether or not it can answer", async () => {
  const { service, plugin } = setup();
  const builderlab = settable("needs-setup");
  const typesafe = settable("ready");
  const community = "wss://community.example";
  let offered = true;
  await plugin("buzz.typesafe", { id: "typesafe", ...typesafe });
  await plugin("block.builderlab", {
    id: "builderlab",
    ...builderlab,
    offered: () => offered,
  });
  // Builderlab is offered, so it is the provider even while it cannot
  // answer: a ready TypeSafe does not answer in its place.
  expect(service.backend(community)).toBe("block.builderlab/builderlab");
  expect(service.status(community)).toBe("needs-setup");
  builderlab.set("checking");
  expect(service.backend(community)).toBe("block.builderlab/builderlab");
  expect(service.status(community)).toBe("checking");
  builderlab.set("ready");
  expect(service.status(community)).toBe("ready");
  // Where it is not offered, and for a request with no community, TypeSafe
  // is the default.
  offered = false;
  expect(service.backend(community)).toBe(DEFAULT_DECISION_PROVIDER);
  expect(service.backend()).toBe(DEFAULT_DECISION_PROVIDER);
  // A chosen provider that cannot answer stays the provider.
  offered = true;
  typesafe.set("needs-setup");
  service.setBackend(DEFAULT_DECISION_PROVIDER, community);
  expect(service.backend(community)).toBe(DEFAULT_DECISION_PROVIDER);
  expect(service.status(community)).toBe("needs-setup");
  builderlab.set("needs-setup");
  typesafe.set("ready");
  service.setBackend("block.builderlab/builderlab", community);
  expect(service.backend(community)).toBe("block.builderlab/builderlab");
  expect(service.status(community)).toBe("needs-setup");
});

it("routes each community's requests to its own provider, and no other", async () => {
  const { service, plugin } = setup();
  // Providers see each community as its relay origin.
  const offered = "https://offered.example";
  const other = "https://other.example";
  const asked: (string | undefined)[] = [];
  const typesafe = settable("ready");
  // Builderlab is offered, and answers, only where the community offers it.
  const builderlab = {
    status: (community?: string) =>
      community === offered ? ("ready" as const) : ("needs-setup" as const),
    offered: (community: string) => community === offered,
    decide: async (sent: DecisionRequest) => {
      asked.push(sent.community);
      return sent.community === offered
        ? reply
        : {
            outcome: "failed" as const,
            reason: "missing_credentials" as const,
          };
    },
  };
  await plugin("buzz.typesafe", {
    id: "typesafe",
    ...typesafe,
    decide: async (sent) => {
      asked.push(`typesafe:${sent.community}`);
      return reply;
    },
  });
  await plugin("block.builderlab", { id: "builderlab", ...builderlab });
  expect(service.backend(offered)).toBe("block.builderlab/builderlab");
  expect(service.backend(other)).toBe(DEFAULT_DECISION_PROVIDER);
  expect(service.status(other)).toBe("ready");
  expect(service.backend()).toBe(DEFAULT_DECISION_PROVIDER);
  const answered = [
    await service.decide({ ...request, community: offered }),
    await service.decide({ ...request, community: other }),
  ];
  expect(answered.map(({ backend }) => backend)).toEqual([
    "block.builderlab/builderlab",
    DEFAULT_DECISION_PROVIDER,
  ]);
  expect(asked).toEqual([offered, `typesafe:${other}`]);
  // A Builderlab chosen everywhere answers where it can and fails elsewhere:
  // TypeSafe does not answer in its place.
  service.setBackend("block.builderlab/builderlab");
  asked.length = 0;
  expect(service.backend(other)).toBe("block.builderlab/builderlab");
  expect(service.status(other)).toBe("needs-setup");
  await expect(
    service.decide({ ...request, community: other }),
  ).resolves.toMatchObject({
    outcome: "failed",
    backend: "block.builderlab/builderlab",
    reason: "missing_credentials",
  });
  expect(asked).toEqual([other]);
  // Without TypeSafe's key, a community that uses it has no answer.
  service.setBackend(DEFAULT_DECISION_PROVIDER);
  typesafe.set("needs-setup");
  expect(service.backend(offered)).toBe(DEFAULT_DECISION_PROVIDER);
  expect(service.status(other)).toBe("needs-setup");
  // A chosen provider that is not a default never falls back either.
  await plugin("acme.other", { id: "other", status: () => "needs-setup" });
  service.setBackend("acme.other/other");
  expect(service.backend(other)).toBe("acme.other/other");
  expect(service.status(other)).toBe("needs-setup");
});

it("keeps a choice for each community, by host, across reloads", async () => {
  const storage = memory();
  const { root, service, plugin } = setup(storage);
  const block = "wss://Buzz.Block.example";
  const hiking = "wss://hiking.example";
  const typesafe = settable("ready");
  await plugin("buzz.typesafe", { id: "typesafe", ...typesafe });
  await plugin("block.builderlab", {
    id: "builderlab",
    status: (community?: string) =>
      community?.toLowerCase().includes("buzz.block.example")
        ? "ready"
        : "needs-setup",
    offered: (community) =>
      !!community?.toLowerCase().includes("buzz.block.example"),
  });
  await plugin("acme.helper", { id: "p" });
  const changed = vi.fn();
  service.subscribe(changed);
  // A choice for one community changes only that community.
  service.setBackend("acme.helper/p", hiking);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(service.backend(hiking)).toBe("acme.helper/p");
  expect(service.backend(block)).toBe("block.builderlab/builderlab");
  expect(service.backend()).toBe(DEFAULT_DECISION_PROVIDER);
  // Its https:// URL, as Settings lists it, shares the choice.
  service.setBackend(DEFAULT_DECISION_PROVIDER, "https://buzz.block.example");
  expect(service.backend(block)).toBe(DEFAULT_DECISION_PROVIDER);
  expect(service.chosenIn(block)).toBe(DEFAULT_DECISION_PROVIDER);
  // A community that is not a URL keeps no choice.
  service.setBackend("acme.helper/p", "not a relay");
  expect(service.backend("not a relay")).toBe(DEFAULT_DECISION_PROVIDER);
  expect(
    JSON.parse(storage.getItem(COMMUNITY_DECISION_BACKENDS_KEY) ?? "null"),
  ).toEqual({
    "hiking.example": "acme.helper/p",
    "buzz.block.example": DEFAULT_DECISION_PROVIDER,
  });
  expect(storage.getItem(DECISION_BACKEND_KEY)).toBeNull();
  await root.fiber.dispose();
  // After a reload, each community keeps its own; a retired provider's
  // choices go, and those communities use the defaults again.
  const reloaded = setup(storage);
  await reloaded.plugin("buzz.typesafe", { id: "typesafe", ...typesafe });
  await reloaded.plugin("acme.helper", { id: "p" });
  expect(reloaded.service.backend(hiking)).toBe("acme.helper/p");
  reloaded.root
    .extend({ pluginOwner: { id: "acme.helper", revision: "one" } })
    .decisions.retireProvider("p");
  expect(reloaded.service.backend(hiking)).toBe(DEFAULT_DECISION_PROVIDER);
  expect(
    JSON.parse(storage.getItem(COMMUNITY_DECISION_BACKENDS_KEY) ?? "null"),
  ).toEqual({ "buzz.block.example": DEFAULT_DECISION_PROVIDER });
  await reloaded.root.fiber.dispose();
});

it("applies a choice saved before per-community choices where a community has none", async () => {
  const storage = memory({
    [DECISION_BACKEND_KEY]: "acme.helper/p",
    [COMMUNITY_DECISION_BACKENDS_KEY]: JSON.stringify({
      "hiking.example": DEFAULT_DECISION_PROVIDER,
    }),
  });
  const { root, service, plugin } = setup(storage);
  await plugin("buzz.typesafe", { id: "typesafe" });
  // The earlier choice is not a default: decisions stay unavailable until it
  // registers, rather than going to TypeSafe.
  expect(service.backend("wss://other.example")).toBeUndefined();
  expect(service.backend("wss://hiking.example")).toBe(
    DEFAULT_DECISION_PROVIDER,
  );
  await plugin("acme.helper", { id: "p" });
  expect(service.backend("wss://other.example")).toBe("acme.helper/p");
  expect(service.backend()).toBe("acme.helper/p");
  await root.fiber.dispose();
});

it("asks no provider in a community where the user turned decisions off", async () => {
  const storage = memory({
    [DECISION_BACKEND_KEY]: "block.builderlab/builderlab",
  });
  const { root, service, plugin } = setup(storage);
  const typesafe = vi.fn(async () => reply);
  const builderlab = vi.fn(async () => reply);
  await plugin("buzz.typesafe", { id: "typesafe", decide: typesafe });
  await plugin("block.builderlab", { id: "builderlab", decide: builderlab });
  const off = "wss://billed.example";
  const other = "wss://other.example";
  const changed = vi.fn();
  service.subscribe(changed);
  service.setBackend(DECISIONS_OFF, off);
  expect(changed).toHaveBeenCalledOnce();
  // Off wins over the choice saved for every community, and nothing
  // answers in its place, not even TypeSafe.
  expect(service.chosenIn(off)).toBe(DECISIONS_OFF);
  expect(service.backend(off)).toBeUndefined();
  expect(service.status(off)).toBe("unavailable");
  await expect(
    service.decide({ ...request, community: off }),
  ).resolves.toMatchObject({ outcome: "failed", reason: "unavailable" });
  // Every spelling of the community is the same one: Settings saves the
  // https origin, a plugin may name it by its relay URL with a final DNS
  // dot, any case or the default port.
  for (const spelling of [
    "https://billed.example",
    "wss://billed.example.",
    "wss://BILLED.example:443/",
  ]) {
    expect(service.chosenIn(spelling)).toBe(DECISIONS_OFF);
    await expect(
      service.decide({ ...request, community: spelling }),
    ).resolves.toMatchObject({ outcome: "failed", reason: "unavailable" });
  }
  expect(typesafe).not.toHaveBeenCalled();
  expect(builderlab).not.toHaveBeenCalled();
  // Other communities keep their providers.
  expect(service.backend(other)).toBe("block.builderlab/builderlab");
  // It is kept across a reload, and stays off while providers come and go.
  await root.fiber.dispose();
  const reloaded = setup(storage);
  await reloaded.plugin("buzz.typesafe", { id: "typesafe", decide: typesafe });
  expect(reloaded.service.chosenIn(off)).toBe(DECISIONS_OFF);
  expect(reloaded.service.backend(off)).toBeUndefined();
  reloaded.root
    .extend({ pluginOwner: { id: "block.builderlab", revision: "one" } })
    .decisions.retireProvider("builderlab");
  expect(reloaded.service.chosenIn(off)).toBe(DECISIONS_OFF);
  // Choosing a provider turns it back on.
  reloaded.service.setBackend(DEFAULT_DECISION_PROVIDER, off);
  expect(reloaded.service.backend(off)).toBe(DEFAULT_DECISION_PROVIDER);
  await reloaded.root.fiber.dispose();
});

it("treats a provider whose offered() throws as not offered, and never rejects", async () => {
  const { service, plugin } = setup();
  const thrower = vi.fn(async () => reply);
  const typesafe = vi.fn(async () => reply);
  await plugin("block.builderlab", {
    id: "builderlab",
    decide: thrower,
    offered: () => {
      throw new Error("plugin bug");
    },
  });
  await plugin("buzz.typesafe", { id: "typesafe", decide: typesafe });
  const community = "wss://relay.example";
  // With no choice, the default that throws is skipped for the next one.
  expect(service.backend(community)).toBe(DEFAULT_DECISION_PROVIDER);
  await expect(
    service.decide({ ...request, community }),
  ).resolves.toMatchObject({ outcome: "answered" });
  expect(thrower).not.toHaveBeenCalled();
  expect(typesafe).toHaveBeenCalledOnce();
});

it("routes every spelling of a community as its relay origin", async () => {
  const { service, plugin } = setup();
  const typesafe = vi.fn(async () => reply);
  const asked: (string | undefined)[] = [];
  const origin = "https://relay.example";
  // Builderlab knows the community only by its relay origin, as joined
  // communities spell it.
  await plugin("buzz.typesafe", { id: "typesafe", decide: typesafe });
  await plugin("block.builderlab", {
    id: "builderlab",
    status: (community?: string) =>
      community === origin ? ("ready" as const) : ("needs-setup" as const),
    offered: (community: string) => community === origin,
    decide: async (sent: DecisionRequest) => {
      asked.push(sent.community);
      return reply;
    },
  });
  const spellings = [
    origin,
    "wss://relay.example",
    "wss://relay.example.",
    "wss://RELAY.example:443/",
  ];
  for (const spelling of spellings) {
    expect(service.backend(spelling)).toBe("block.builderlab/builderlab");
    expect(service.status(spelling)).toBe("ready");
    await expect(
      service.decide({ ...request, community: spelling }),
    ).resolves.toMatchObject({
      outcome: "answered",
      backend: "block.builderlab/builderlab",
    });
  }
  expect(asked).toEqual(spellings.map(() => origin));
  expect(typesafe).not.toHaveBeenCalled();
});

it("ignores malformed saved community choices", async () => {
  for (const saved of ["{", "[]", JSON.stringify({ "a.example": 7 })]) {
    const { root, service, plugin } = setup(
      memory({ [COMMUNITY_DECISION_BACKENDS_KEY]: saved }),
    );
    await plugin("buzz.typesafe", { id: "typesafe" });
    expect(service.backend("wss://a.example")).toBe(DEFAULT_DECISION_PROVIDER);
    await root.fiber.dispose();
  }
});

it("holds a request for a checking provider, and never sends it elsewhere", async () => {
  const { service, plugin, timers } = setup();
  const builderlab = settable("checking");
  const fromBuilderlab = vi.fn(async () => reply);
  const fromTypesafe = vi.fn(async () => reply);
  await plugin("buzz.typesafe", {
    id: "typesafe",
    ...settable("ready"),
    decide: fromTypesafe,
  });
  await plugin("block.builderlab", {
    id: "builderlab",
    ...builderlab,
    decide: fromBuilderlab,
  });
  // A ready TypeSafe does not answer while Builderlab checks.
  const held = service.decide(request);
  await flush();
  expect(fromBuilderlab).not.toHaveBeenCalled();
  builderlab.set("needs-setup");
  await expect(held).resolves.toMatchObject({
    backend: "block.builderlab/builderlab",
  });
  expect(fromBuilderlab).toHaveBeenCalledOnce();
  builderlab.set("checking");
  const granted = service.decide(request);
  await flush();
  builderlab.set("ready");
  await expect(granted).resolves.toMatchObject({
    outcome: "answered",
    backend: "block.builderlab/builderlab",
  });
  expect(fromBuilderlab).toHaveBeenCalledTimes(2);
  // The wait counts against the request's deadline.
  builderlab.set("checking");
  const late = service.decide(request);
  await flush();
  timers[0]?.run();
  await expect(late).resolves.toMatchObject({ reason: "timeout" });
  expect(fromBuilderlab).toHaveBeenCalledTimes(2);
  expect(fromTypesafe).not.toHaveBeenCalled();
});

it("removes a provider when the plugin asks, before its scope ends", async () => {
  const { root, service } = setup();
  let remove = () => {};
  const fiber = root
    .extend({ pluginOwner: { id: "buzz.typesafe", revision: "one" } })
    .plugin((ctx) => {
      remove = ctx.decisions.registerProvider(fake({ id: "typesafe" }));
    });
  await fiber.await();
  await flush();
  expect(service.providers()).toHaveLength(1);
  remove();
  expect(service.providers()).toEqual([]);
  // Ending the scope afterwards is harmless.
  remove();
  await fiber.dispose();
  expect(service.providers()).toEqual([]);
});

it("says decisions can be answered while the provider they go to isn't waiting for setup", async () => {
  const { root, plugin } = setup();
  const seen: string[] = [];
  // A consumer, as a plugin that needs decisions registers its contributions.
  await root
    .plugin((ctx) => {
      ctx.inject(["decisionsAnswerable"], (scope) => {
        seen.push(`on ${scope.decisionsAnswerable?.version}`);
        scope.effect(() => () => void seen.push("off"));
      });
    })
    .await();
  await flush();
  expect(seen).toEqual([]);
  // A default install: TypeSafe registered without a key.
  const keyless = await plugin("buzz.typesafe", {
    id: "typesafe",
    status: () => "needs-setup",
  });
  await flush();
  expect(seen).toEqual([]);
  const status = settable("checking");
  const builderlab = await plugin("block.builderlab", {
    id: "builderlab",
    ...status,
  });
  await flush();
  expect(seen).toEqual(["on 1"]);
  // Checking and unconfirmed don't flap it; needs-setup withdraws it.
  status.set("unconfirmed");
  status.set("ready");
  await flush();
  expect(seen).toEqual(["on 1"]);
  status.set("needs-setup");
  await flush();
  expect(seen).toEqual(["on 1", "off"]);
  await keyless.dispose();
  await plugin("buzz.typesafe", { id: "typesafe" });
  await flush();
  expect(seen).toEqual(["on 1", "off", "on 1"]);
  await builderlab.dispose();
  await flush();
  expect(seen).toEqual(["on 1", "off", "on 1"]);
});

it("restores a saved choice once its provider registers, and survives unreadable storage", async () => {
  const { service, plugin } = setup(
    memory({ [DECISION_BACKEND_KEY]: "b/main" }),
  );
  await plugin("buzz.typesafe", { id: "typesafe", order: 0 });
  // Not registered yet: unavailable, not TypeSafe.
  expect(service.backend()).toBeUndefined();
  await plugin("b", { order: 1, status: () => "needs-setup" });
  expect(service.backend()).toBe("b/main");
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  } as unknown as Storage;
  const other = setup(broken);
  await other.plugin("buzz.typesafe", { id: "typesafe" });
  await other.plugin("b", { order: 1 });
  expect(other.service.backend()).toBe(DEFAULT_DECISION_PROVIDER);
  other.service.setBackend("b/main");
  expect(other.service.backend()).toBe("b/main");
});

it("checks requests before any provider sees them", async () => {
  const { service, plugin } = setup();
  const decide = vi.fn<DecisionProvider["decide"]>(async () => reply);
  await plugin("buzz.typesafe", { id: "typesafe", decide });
  for (const bad of [
    { ...request, state: " " },
    { ...request, questions: {} },
    {
      ...request,
      questions: { pick: { type: "choice", instructions: "x", options: {} } },
    },
    {
      ...request,
      questions: { rate: { type: "score", instructions: "x", levels: ["a"] } },
    },
    { ...request, questions: { ["x".repeat(65)]: request.questions.urgent } },
    { ...request, community: " " },
    { ...request, community: 1 },
    // A plugin may send anything at all.
    null,
    undefined,
    "urgent?",
  ] as unknown as DecisionRequest[])
    await expect(service.decide(bad)).resolves.toMatchObject({
      reason: "invalid_request",
    });
  await expect(
    service.decide({ ...request, state: "x".repeat(128 * 1024) }),
  ).resolves.toMatchObject({ reason: "input_limit" });
  expect(decide).not.toHaveBeenCalled();
});

it("checks answers against the questions", async () => {
  const questions: DecisionRequest["questions"] = {
    urgent: { type: "yes_no", instructions: "Urgent." },
    pick: {
      type: "choice",
      instructions: "Which.",
      options: { a: "A", b: "B" },
    },
    rate: { type: "score", instructions: "How.", levels: ["low", "high"] },
  };
  const good = {
    urgent: { type: "yes_no", probability: 1 },
    pick: {
      type: "choice",
      choice: "b",
      confidence: 0.5,
      probabilities: { a: 0.5, b: 0.5 },
    },
    rate: { type: "score", score: 0.5, confidence: 0.9 },
    extra: { type: "yes_no", probability: 0.1 },
  };
  let answers: unknown = good;
  const { service, plugin } = setup();
  await plugin("buzz.typesafe", {
    id: "typesafe",
    decide: async () => ({ outcome: "answered", model: "m", answers }) as never,
  });
  const result = await service.decide({ ...request, questions });
  expect(result).toEqual({
    outcome: "answered",
    backend: "buzz.typesafe/typesafe",
    model: "m",
    answers: {
      urgent: good.urgent,
      pick: good.pick,
      // Missing probabilities are none; answers not asked for are dropped.
      rate: { ...good.rate, probabilities: {} },
    },
  });
  for (const bad of [
    { ...good, urgent: { type: "yes_no", probability: 2 } },
    { ...good, urgent: { type: "choice", choice: "a", confidence: 1 } },
    { ...good, pick: { ...good.pick, choice: "toString" } },
    { ...good, pick: { ...good.pick, probabilities: { c: 0.1 } } },
    { ...good, rate: { ...good.rate, score: 2 } },
    { ...good, rate: { ...good.rate, probabilities: { "01": 0.1 } } },
    Object.assign(Object.create({ urgent: good.urgent }), {
      pick: good.pick,
      rate: good.rate,
    }),
    null,
  ]) {
    answers = bad;
    await expect(
      service.decide({ ...request, questions }),
    ).resolves.toMatchObject({ outcome: "failed", reason: "invalid_response" });
  }
});

it("keeps every question name as the answer's own key, even __proto__", async () => {
  // Parsed, so "__proto__" is an own question name, as a plugin can send.
  const questions = JSON.parse(
    '{"__proto__":{"type":"yes_no","instructions":"Odd."},"urgent":{"type":"yes_no","instructions":"Urgent."}}',
  ) as DecisionRequest["questions"];
  const answers = JSON.parse(
    '{"__proto__":{"type":"yes_no","probability":0.3},"urgent":{"type":"yes_no","probability":0.8}}',
  );
  const { service, plugin } = setup();
  await plugin("buzz.typesafe", {
    id: "typesafe",
    decide: async () => ({ outcome: "answered", model: "m", answers }) as never,
  });
  const result = await service.decide({ ...request, questions });
  if (result.outcome !== "answered") throw new Error(result.reason);
  expect(Object.keys(result.answers)).toEqual(["__proto__", "urgent"]);
  expect(Object.getPrototypeOf(result.answers)).toBe(Object.prototype);
  // An unasked name does not resolve to the __proto__ answer's fields.
  expect((result.answers as Record<string, unknown>).probability).toBe(
    undefined,
  );
  expect(JSON.parse(JSON.stringify(result.answers))).toEqual(answers);
});

it("turns provider failures, throws and wrong replies into failures", async () => {
  let decide: DecisionProvider["decide"] = async () => {
    throw new Error("down");
  };
  const { service, plugin } = setup();
  await plugin("buzz.typesafe", {
    id: "typesafe",
    decide: (...args) => decide(...args),
  });
  const failed = (reason: string) => ({
    outcome: "failed",
    backend: "buzz.typesafe/typesafe",
    reason,
  });
  await expect(service.decide(request)).resolves.toEqual(
    failed("service_error"),
  );
  for (const [odd, reason] of [
    [{ outcome: "failed", reason: "unauthorized" }, "unauthorized"],
    [{ outcome: "failed", reason: "other" }, "invalid_response"],
    [{ outcome: "answered", answers: reply.answers }, "invalid_response"],
    [null, "invalid_response"],
  ] as const) {
    decide = async () => odd as never;
    await expect(service.decide(request)).resolves.toEqual(failed(reason));
  }
});

it("stops waiting at the deadline and aborts the provider", async () => {
  const { service, plugin, timers } = setup();
  let signal: AbortSignal | undefined;
  await plugin("buzz.typesafe", {
    id: "typesafe",
    decide: (_request, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  });
  const result = service.decide({ ...request, timeoutMs: 5 });
  await flush();
  // Held to at least a second.
  expect(timers.map((timer) => timer.ms)).toEqual([1_000]);
  timers[0]?.run();
  await expect(result).resolves.toEqual({
    outcome: "failed",
    backend: "buzz.typesafe/typesafe",
    reason: "timeout",
  });
  expect(signal?.aborted).toBe(true);
  expect(timers).toEqual([]);
});

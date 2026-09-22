import { expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { PluginRuntime } from "../../plugins/runtime";
import { createRelaySession } from "../relay/session";
import { createAgentLibrary } from "../agents/library";
import { agentDirectory } from "../../bundled/agents/directory";
import { IdentityNamesService, bindNames, type NameSource } from "./service";

const key = "ab".repeat(32);
function fixture() {
  let name = "  Local Larry  ";
  let fail = false;
  const library = createAgentLibrary(async () => {
    if (fail) throw new Error("unavailable");
    return {
      definitions: [],
      identities: [{ pubkey: key.toUpperCase(), name }],
    };
  });
  const source: NameSource = {
    profiles: {
      snapshot: () => new Map([[key, { name: "Public Larry" }]]),
      subscribe: () => () => {},
      ensure: async () => {},
    },
    agentLibrary: library.queries,
  };
  return {
    source,
    library,
    rename(value: string) {
      name = value;
    },
    fail() {
      fail = true;
    },
  };
}

it("reads the existing local inventory without changing public profile evidence", async () => {
  const f = fixture();
  const providers = {
    snapshot: () => [agentDirectory],
    subscribe: () => () => {},
  };
  const view = bindNames(f.source, providers);
  const changed = vi.fn();
  view.subscribe(changed);
  expect(view.resolve(key)).toBe("Public Larry");
  await f.library.queries.refresh();
  expect(view.resolve(key)).toBe("Local Larry");
  expect(changed).toHaveBeenCalled();
  expect(f.source.profiles.snapshot().get(key)?.name).toBe("Public Larry");
  f.rename("Renamed");
  await f.library.queries.refresh();
  expect(view.resolve(key)).toBe("Renamed");
  f.rename("   ");
  await f.library.queries.refresh();
  expect(view.resolve(key)).toBe("Public Larry");
  f.fail();
  await f.library.queries.refresh();
  expect(view.resolve(key)).toBe("Public Larry");
  expect(view.resolve("missing", "Unknown")).toBe("Unknown");
  const revision = view.snapshot();
  view.dispose();
  f.library.clear();
  expect(view.snapshot()).toBe(revision);
  expect(view.resolve(key, "retired")).toBe("retired");
  f.library.dispose();
});

it("rebinds a live name view on plugin replacement and disable", async () => {
  const f = fixture();
  const ctx = new Context();
  const runtime = new PluginRuntime(ctx, async (plugin) => ({
    inject: ["identityNames"],
    apply: (scope) =>
      scope.identityNames.register({
        ...agentDirectory,
        resolve: () => plugin.revision,
      }),
  }));
  const names = new IdentityNamesService(ctx);
  const owner = createRelaySession(null, { identityNames: names });
  const view = owner.session.names;
  const plugin = (revision: string) => ({
    manifest: { id: "test.agents", name: "Agents", apiVersion: 1 as const },
    source: "bundled" as const,
    enabled: true,
    revision,
    previous: null,
    error: null,
  });
  try {
    expect(view.resolve(key)).toBeUndefined();
    runtime.reconcile([plugin("one")]);
    await vi.waitFor(() => expect(view.resolve(key)).toBe("one"));
    runtime.reconcile([plugin("two")]);
    await vi.waitFor(() => expect(view.resolve(key)).toBe("two"));
    runtime.reconcile([]);
    await vi.waitFor(() => expect(view.resolve(key)).toBeUndefined());
  } finally {
    owner.dispose();
    await runtime.dispose();
    await ctx.fiber.dispose();
    f.library.dispose();
  }
});

it("ignores competing providers and cannot reactivate a disposed view", () => {
  const f = fixture();
  const activate = vi.fn();
  const provider = { ...agentDirectory, activate, resolve: () => "Override" };
  let entries = [provider, provider];
  let update = () => {};
  const view = bindNames(f.source, {
    snapshot: () => entries,
    subscribe: (listener) => {
      update = listener;
      return () => {};
    },
  });
  expect(view.resolve(key)).toBe("Public Larry");
  expect(activate).not.toHaveBeenCalled();
  view.dispose();
  entries = [provider];
  update();
  expect(activate).not.toHaveBeenCalled();
  f.library.dispose();
});

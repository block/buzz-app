// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createAgentLibrary } from "../agents/library";
import { eventDto } from "../relay/events";
import { createProfileDirectory } from "../relay/profile-directory";
import { keypair, signed } from "../relay/testing";
import type { VerifiedProfileSink } from "../relay/verified-profile";
import { useIdentityNames } from "./react";
import { bindNames } from "./service";
import { createAgentDirectory } from "./testing";
import {
  namePreference,
  setNamePreference,
  useNamePreference,
} from "./name-preference";

const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
  vi.restoreAllMocks();
  setNamePreference("display");
  localStorage.clear();
});

async function fixture() {
  const relay = keypair();
  const alice = keypair();
  const bob = keypair();
  let sink: VerifiedProfileSink | undefined;
  const directory = createProfileDirectory(
    { read: async () => [] },
    undefined,
    undefined,
    {
      authority: { pubkey: relay.pubkey, multipleIssuers: false },
      subscribe(_filter, next) {
        sink = next;
        return () => {};
      },
    },
  );
  disposals.push(() => directory.dispose());
  const profile = eventDto(
    signed(alice, {
      kind: 0,
      tags: [],
      content: JSON.stringify({ name: "Self name" }),
    }),
  );
  directory.accept([profile]);
  await directory.ensure([alice.pubkey, bob.pubkey]);
  assert(sink);
  const projection = (
    pubkey: string,
    display: string,
    full?: string,
    at = 10,
  ) =>
    eventDto(
      signed(relay, {
        kind: 30382,
        content: "",
        created_at: at,
        tags: [
          ["d", pubkey],
          ["p", pubkey],
          ["active", "true"],
          ["display_name", display],
          ["username", display],
          ["issuer_label", "Example"],
          ["verified_at", String(at)],
          ...(full ? [["full_name", full]] : []),
        ],
      }),
    );
  sink.event(projection(alice.pubkey, "alice", "Alice Example"));
  sink.event(projection(bob.pubkey, "bob"));
  sink.eose();
  await waitFor(() =>
    expect(
      directory.queries.snapshot().get(alice.pubkey)?.verified?.status,
    ).toBe("checked"),
  );
  return { relay, alice, bob, directory, sink, projection, profile };
}

it("updates mounted identity labels immediately, keeps signed evidence, and falls back without a full name", async () => {
  const f = await fixture();
  const library = createAgentLibrary(async () => ({
    definitions: [],
    identities: [],
  }));
  const provider = createAgentDirectory();
  const names = bindNames(
    { profiles: f.directory.queries, agentLibrary: library.queries },
    {
      snapshot: () => [provider],
      subscribe: () => () => {},
    },
  );
  disposals.push(
    () => names.dispose(),
    () => library.dispose(),
  );
  const hook = renderHook(() => {
    const resolve = useIdentityNames(names);
    return resolve(f.alice.pubkey, "Unknown");
  });
  expect(hook.result.current).toBe("alice");
  act(() => setNamePreference("full"));
  expect(hook.result.current).toBe("Alice Example");
  expect(names.resolve(f.bob.pubkey)).toBe("bob");
  expect(f.directory.event(f.alice.pubkey)).toBe(f.profile);
  expect(
    f.directory.queries.snapshot().get(f.alice.pubkey)?.verified?.displayName,
  ).toBe("alice");
  act(() => setNamePreference("display"));
  expect(hook.result.current).toBe("alice");
});

it("restores a saved choice and qualifies full-name collisions, including self-declared names", async () => {
  localStorage.setItem("buzz-name-preference.v1", "full");
  const f = await fixture();
  expect(f.directory.queries.snapshot().get(f.alice.pubkey)?.name).toBe(
    "Alice Example",
  );
  const impostor = keypair();
  f.directory.accept([
    eventDto(
      signed(impostor, {
        kind: 0,
        tags: [],
        content: JSON.stringify({ name: "Alice Example" }),
      }),
    ),
  ]);
  expect(f.directory.queries.snapshot().get(impostor.pubkey)?.name).toContain(
    impostor.pubkey.slice(0, 10),
  );
  f.sink.event(f.projection(f.bob.pubkey, "bob", "Alice Example", 20));
  f.sink.eose();
  await waitFor(() => {
    for (const key of [f.alice.pubkey, f.bob.pubkey])
      expect(f.directory.queries.snapshot().get(key)?.name).toBe(
        `Alice Example (${key.slice(0, 10)})`,
      );
  });
});

it("reacts to other-window changes and storage clears, and stops listening when disposed", async () => {
  const f = await fixture();
  const hook = renderHook(useNamePreference);
  const changed = vi.fn();
  f.directory.queries.subscribe(changed);
  act(() => {
    localStorage.setItem("buzz-name-preference.v1", "full");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "buzz-name-preference.v1" }),
    );
  });
  expect(hook.result.current.preference).toBe("full");
  expect(f.directory.queries.snapshot().get(f.alice.pubkey)?.name).toBe(
    "Alice Example",
  );
  act(() => {
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
  });
  expect(namePreference()).toBe("display");
  expect(f.directory.queries.snapshot().get(f.alice.pubkey)?.name).toBe(
    "alice",
  );
  act(() => f.directory.dispose());
  changed.mockClear();
  act(() => setNamePreference("full"));
  expect(changed).not.toHaveBeenCalled();
});

it("uses display names when storage cannot be read or has an unknown value", () => {
  localStorage.setItem("buzz-name-preference.v1", "unknown");
  expect(namePreference()).toBe("display");
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  expect(namePreference()).toBe("display");
});

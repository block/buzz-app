import { expect, it, vi } from "vitest";
import { keypair, signed } from "../relay/testing";
import { eventDto } from "../relay/events";
const relay = keypair();
const person = keypair();
const viewer = person.pubkey;
const profileEvent = (existing: Record<string, unknown>, at = 10) =>
  eventDto(
    signed(person, {
      kind: 0,
      content: JSON.stringify(existing),
      tags: [],
      created_at: at,
    }),
  );
const authority = { pubkey: relay.pubkey, multipleIssuers: false };
const identityEvent = eventDto(
  signed(relay, {
    kind: 30382,
    content: "",
    created_at: 10,
    tags: [
      ["d", viewer],
      ["p", viewer],
      ["active", "true"],
      ["display_name", "Alice"],
      ["username", "alice"],
      ["issuer_label", "Example"],
      ["verified_at", "10"],
    ],
  }),
);
import type { Communities } from "../communities/service";
import type { RelaySession } from "../relay/session";
import { beginProfileSave, endProfileSave } from "../communities/profile-saves";
import {
  profilePhotoChoice,
  syncManagedProfile,
  type ProfileSyncOptions,
} from "./profile-source";

function fixture(existing: Record<string, unknown> = {}) {
  const managed = {
    version: 1 as const,
    source_label: "Directory",
    source_url: "https://example.org/alice",
    fields: [],
    timezone: "Europe/London",
    picture: "https://example.org/alice.png",
  };
  const verifiedRevision = vi.fn(() => 0);
  const session = {
    viewer,
    scope: `https://example.org:${viewer}`,
    profiles: {
      verifiedRevision,
      verifiedAuthority: () => authority,
    },
    read: vi.fn(async () => [identityEvent, profileEvent(current.existing)]),
    directMessages: {
      verified: vi.fn(async () => ({
        profiles: new Map([
          ["alice", { status: "checked", username: "alice" }],
        ]),
      })),
    },
  } as unknown as RelaySession;
  const communities = {
    relay: { snapshot: () => ({ session }) },
  } as unknown as Communities;
  const current = {
    exists: true,
    existing: {
      name: "Alice",
      display_name: "Alice",
      picture: "",
      about: "",
      ...existing,
    },
    profile: {
      name: "Alice",
      picture: typeof existing.picture === "string" ? existing.picture : "",
      about: "",
    },
  };
  const provider = {
    id: "directory",
    key: "example/directory",
    matches: () => true,
    refresh: vi.fn(async () => managed),
  };
  const entries = [provider];
  const options: ProfileSyncOptions = {
    session,
    providers: {
      register: () => {},
      snapshot: () => entries,
      subscribe: () => () => {},
    },
    community: "https://example.org",
    viewer,
    communities,
    read: Promise.resolve([]),
    inspect: vi.fn(async () => current),
    publish: vi.fn(async (_profile, metadata) => {
      Object.assign(current.existing, metadata);
    }),
    zone: "UTC",
  };
  return { options, current, session, provider, entries, verifiedRevision };
}

it("leaves ordinary profile sharing alone when no providers are enabled", async () => {
  const { options, entries, session } = fixture();
  entries.length = 0;
  expect(await syncManagedProfile(options)).toBeUndefined();
  expect(session.directMessages.verified).not.toHaveBeenCalled();
  expect(session.read).not.toHaveBeenCalled();
  expect(options.inspect).not.toHaveBeenCalled();
  expect(options.publish).not.toHaveBeenCalled();
});

it("saves self-fetched directory details and preserves other profile metadata", async () => {
  const { options } = fixture();
  expect(await syncManagedProfile(options)).toBe(true);
  expect(options.publish).toHaveBeenCalledWith(
    { name: "Alice", picture: "https://example.org/alice.png", about: "" },
    {
      name: "Alice",
      display_name: "Alice",
      picture: "https://example.org/alice.png",
      about: "",
      managed_photo_initialized: true,
      tz: "Europe/London",
      profile_extensions: {
        "example/directory": {
          username: "alice",
          data: expect.objectContaining({ source_label: "Directory" }),
        },
      },
    },
    true,
  );
});

it.each([
  { picture: "https://example.org/chosen.png" },
  { picture: "", managed_photo_initialized: true },
])("preserves chosen and explicitly removed photos: %j", async (existing) => {
  const { options } = fixture(existing);
  await syncManagedProfile(options);
  expect(options.publish).toHaveBeenCalledWith(
    expect.objectContaining({ picture: existing.picture }),
    expect.anything(),
    true,
  );
});

it("records explicit photo replacement and removal", () => {
  expect(
    profilePhotoChoice("https://example.org", { picture: "old" }, ""),
  ).toEqual({ picture: "old", managed_photo_initialized: true });
  expect(
    profilePhotoChoice("https://example.org", { picture: "" }, "new"),
  ).toEqual({ picture: "", managed_photo_initialized: true });
});

it("does not publish after a foreground save starts during inspection", async () => {
  const { options, current } = fixture();
  options.inspect = async () => {
    beginProfileSave(options.communities);
    return current;
  };
  expect(await syncManagedProfile(options)).toBe(false);
  expect(options.publish).not.toHaveBeenCalled();
  endProfileSave(options.communities);
});

it("does not publish when the plugin is disabled during fetch", async () => {
  const { options, provider, entries } = fixture();
  const original = provider.refresh;
  provider.refresh = vi.fn(async () => {
    entries.length = 0;
    return original();
  });
  expect(await syncManagedProfile(options)).toBe(false);
  expect(options.publish).not.toHaveBeenCalled();
});
it("keeps saved metadata when Hub fails", async () => {
  const { options, provider } = fixture({ custom: "keep" });
  provider.refresh.mockRejectedValue(new Error("offline"));
  expect(await syncManagedProfile(options)).toBe(false);
  expect(options.publish).not.toHaveBeenCalled();
});
it("fetches only the signed-in subject", async () => {
  const { options, provider } = fixture();
  await syncManagedProfile(options);
  expect(provider.refresh).toHaveBeenCalledWith(
    {
      community: "https://example.org",
      viewer,
      pubkey: viewer,
      username: "alice",
    },
    expect.any(AbortSignal),
  );
});
it("rejects a changed profile rather than overwriting it", async () => {
  const { options, current, session } = fixture();
  vi.mocked(session.read)
    .mockResolvedValueOnce([identityEvent])
    .mockResolvedValueOnce([
      identityEvent,
      profileEvent({ ...current.existing, about: "edited" }),
    ]);
  expect(await syncManagedProfile(options)).toBe(false);
  expect(options.publish).not.toHaveBeenCalled();
});

it("skips a successful refresh for 24 hours and rechecks after expiry", async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  const { options, current, provider } = fixture();
  const now = vi.spyOn(Date, "now").mockReturnValue(100000000);
  vi.mocked(options.publish).mockImplementation(async (_profile, metadata) => {
    Object.assign(current.existing, metadata);
  });
  try {
    await syncManagedProfile(options);
    expect(provider.refresh).toHaveBeenCalledTimes(1);
    await syncManagedProfile(options);
    expect(provider.refresh).toHaveBeenCalledTimes(1);
    now.mockReturnValue(100000000 + 86400001);
    await syncManagedProfile(options);
    expect(provider.refresh).toHaveBeenCalledTimes(2);
  } finally {
    now.mockRestore();
    vi.unstubAllGlobals();
  }
});
it("does not fetch or publish when the session belongs to a different viewer", async () => {
  const { options, provider } = fixture();
  options.viewer = "someone-else";
  expect(await syncManagedProfile(options)).toBe(false);
  expect(provider.refresh).not.toHaveBeenCalled();
  expect(options.publish).not.toHaveBeenCalled();
});

it("preserves distinct names and About whitespace through metadata-only publication", async () => {
  const { options } = fixture({
    name: "alice",
    display_name: "Alice Lee",
    about: "  Kept  ",
  });
  expect(await syncManagedProfile(options)).toBe(true);
  expect(options.publish).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      name: "alice",
      display_name: "Alice Lee",
      about: "  Kept  ",
    }),
    true,
  );
});

it("does not cache a receipt when the intended profile did not win", async () => {
  const setItem = vi.fn();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem });
  const { options } = fixture();
  vi.mocked(options.publish).mockImplementation(async () => {});
  try {
    expect(await syncManagedProfile(options)).toBe(false);
    expect(options.publish).toHaveBeenCalledOnce();
    expect(setItem).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("rejects a directory response after published identity evidence changes", async () => {
  const { options, provider, verifiedRevision } = fixture();
  const refresh = provider.refresh;
  provider.refresh = vi.fn(async () => {
    verifiedRevision.mockReturnValue(1);
    return refresh();
  });
  expect(await syncManagedProfile(options)).toBe(false);
  expect(options.publish).not.toHaveBeenCalled();
});

it("checks fresh signed authority again even without a held own profile", async () => {
  const { options, session } = fixture();
  vi.mocked(session.read)
    .mockResolvedValueOnce([identityEvent])
    .mockResolvedValueOnce([]);
  expect(await syncManagedProfile(options)).toBe(false);
  expect(options.publish).not.toHaveBeenCalled();
  expect(session.read).toHaveBeenCalledTimes(2);
  expect(session.read).toHaveBeenLastCalledWith(
    [
      expect.objectContaining({ consistency: "strong", kinds: [30382] }),
      expect.objectContaining({ consistency: "strong", kinds: [0] }),
    ],
    expect.objectContaining({ fresh: true }),
  );
});
it("rejects identity changes observed during the final profile read", async () => {
  const { options, session, current, verifiedRevision } = fixture();
  vi.mocked(session.read)
    .mockResolvedValueOnce([identityEvent])
    .mockImplementationOnce(async () => {
      verifiedRevision.mockReturnValue(1);
      return [identityEvent, profileEvent(current.existing)];
    });
  expect(await syncManagedProfile(options)).toBe(false);
  expect(options.publish).not.toHaveBeenCalled();
});
it("does not replace the captured session with a newly selected community", async () => {
  const { options, provider } = fixture();
  options.communities = {
    relay: { snapshot: () => ({ session: { viewer } }) },
  } as unknown as Communities;
  expect(await syncManagedProfile(options)).toBe(false);
  expect(provider.refresh).not.toHaveBeenCalled();
  expect(options.publish).not.toHaveBeenCalled();
});

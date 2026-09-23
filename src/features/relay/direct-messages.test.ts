import { expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { keypair, profile, roster, signed } from "./testing";
import { PublishRejected } from "./outbox";
import type { ReadFilter } from "./events";
import type { RelayWriter } from "./transport";

const id = "11111111-1111-4111-8111-111111111111";
function setup(options: { badRoster?: boolean; untrusted?: boolean } = {}) {
  const viewer = keypair(),
    other = keypair(),
    relay = keypair(),
    stranger = keypair();
  const authority = options.untrusted ? stranger : relay;
  const discovery = [
    signed(authority, {
      kind: 39000,
      content: JSON.stringify({ name: "Direct message", channel_type: "dm" }),
      tags: [
        ["d", id],
        ["t", "dm"],
      ],
    }),
    roster(authority, id, [
      viewer.pubkey,
      options.badRoster ? stranger.pubkey : other.pubkey,
    ]),
  ];
  const query = vi.fn(async (filters: readonly ReadFilter[]) => {
    if (filters.some((f) => f.kinds?.includes(0)))
      return [
        profile(viewer, { name: "Me" }),
        profile(other, { name: "Other", is_agent: true }),
      ];
    return discovery;
  });
  const publish = vi.fn<RelayWriter["publish"]>(async () => {});
  const openDirectMessage = vi.fn(async () => id);
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query,
      openDirectMessage,
      writer: {
        kinds: [9],
        sign: async (template) => signed(viewer, template),
        publish,
      },
    },
    { outboxStorage: { load: () => [], save: () => {} } },
  );
  return {
    owner,
    viewer,
    other,
    query,
    publish,
    openDirectMessage,
    dm: owner.session.directMessages,
  };
}
it("opens using signed exact membership, then confirms the regular outbox message", async () => {
  const t = setup();
  try {
    await expect(
      t.dm.open([t.other.pubkey], new AbortController().signal),
    ).resolves.toBe(id);
    expect(t.owner.session.channels.get?.(id)?.channelType).toBe("dm");
    let release = () => {};
    t.publish.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const message = t.owner.session.messages.send(id, "Hello", []);
    let confirmed = false;
    const done = t.dm
      .delivered(message, id, new AbortController().signal)
      .then(() => {
        confirmed = true;
      });
    await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
    expect(confirmed).toBe(false);
    release();
    await done;
    expect(t.dm.delivery(message)).toBe("accepted");
  } finally {
    t.owner.dispose();
  }
});
it.each([{ badRoster: true }, { untrusted: true }])(
  "refuses a receipt without trusted exact participants: %j",
  async (options) => {
    const t = setup(options);
    try {
      await expect(
        t.dm.open([t.other.pubkey], new AbortController().signal),
      ).rejects.toThrow("participants");
      expect(t.publish).not.toHaveBeenCalled();
    } finally {
      t.owner.dispose();
    }
  },
);
it("rejects self, duplicate, empty and over-limit recipients before contacting the host", async () => {
  const t = setup();
  try {
    for (const keys of [
      [],
      [t.viewer.pubkey],
      [t.other.pubkey, t.other.pubkey],
      Array.from({ length: 9 }, () => keypair().pubkey),
    ])
      await expect(
        t.dm.open(keys, new AbortController().signal),
      ).rejects.toThrow("eight");
    expect(t.openDirectMessage).not.toHaveBeenCalled();
  } finally {
    t.owner.dispose();
  }
});
it("retries a rejected first message with the same signed event", async () => {
  const t = setup();
  try {
    await t.dm.open([t.other.pubkey], new AbortController().signal);
    t.publish.mockRejectedValueOnce(
      new PublishRejected("Temporarily rejected"),
    );
    const message = t.owner.session.messages.send(id, "Keep me", []);
    await expect(
      t.dm.delivered(message, id, new AbortController().signal),
    ).rejects.toThrow("Temporarily rejected");
    await t.dm.delivered(message, id, new AbortController().signal);
    expect(t.publish).toHaveBeenCalledTimes(2);
    expect(t.publish.mock.calls[0]?.[0]).toEqual(t.publish.mock.calls[1]?.[0]);
  } finally {
    t.owner.dispose();
  }
});
it("reads paginated verified profiles, excludes the viewer, and cancels with the caller", async () => {
  const t = setup();
  try {
    const page = await t.dm.people("Other", 2, new AbortController().signal);
    expect(page).toEqual({
      people: [{ pubkey: t.other.pubkey, name: "Other", isAgent: true }],
      hasMore: false,
    });
    expect(
      t.query.mock.calls.some(
        ([filters]) =>
          filters[0]?.page === 2 &&
          filters[0]?.limit === 30 &&
          filters[0]?.search === "Other",
      ),
    ).toBe(true);
    const controller = new AbortController();
    controller.abort();
    await expect(t.dm.people("", 1, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  } finally {
    t.owner.dispose();
  }
});

it.each(["", "C"])(
  "keeps large-profile pages within the read budget without skipping matches: %s",
  async (query) => {
    const t = setup();
    try {
      // Production C results carry roughly 200 KB each: 100 exceed the 8 MB reader budget.
      const content = "x".repeat(200_000);
      const directory = Array.from({ length: 65 }, (_, index) =>
        profile(keypair(), { name: `C person ${index}`, about: content }),
      );
      t.query.mockImplementation(async (filters) => {
        const filter = filters[0];
        const start = ((filter?.page ?? 1) - 1) * (filter?.limit ?? 100);
        return directory.slice(start, start + (filter?.limit ?? 100));
      });
      const seen = new Set<string>();
      const signal = new AbortController().signal;
      const lastPage = query ? 3 : 4;
      for (let page = 1; page <= lastPage; page++) {
        const result = await t.dm.people(query, page, signal);
        for (const person of result.people) seen.add(person.pubkey);
        expect(result.hasMore).toBe(page < lastPage);
      }
      expect(seen.size).toBe(65);
      expect(
        t.query.mock.calls
          .flatMap(([filters]) => filters)
          .map((filter) => filter.limit),
      ).toEqual(query ? [30, 30, 30] : [15, 30, 30, 30]);
    } finally {
      t.owner.dispose();
    }
  },
);

it("loads a small directory preview followed by bounded overlapping batches without skipping profiles", async () => {
  const t = setup();
  try {
    const signal = new AbortController().signal;
    await t.dm.people("", 1, signal);
    await t.dm.people("", 2, signal);
    await t.dm.people("", 3, signal);
    const pages = t.query.mock.calls
      .flatMap(([filters]) => filters)
      .filter((filter) => filter.kinds?.includes(0) && filter.page);
    expect(pages).toEqual([
      { kinds: [0], limit: 15, page: 1 },
      { kinds: [0], limit: 30, page: 1 },
      { kinds: [0], limit: 30, page: 2 },
    ]);
  } finally {
    t.owner.dispose();
  }
});

it("browses beyond the shared profile budget without evicting or republishing conversation names", async () => {
  const t = setup();
  try {
    await t.owner.session.profiles.ensure([t.other.pubkey]);
    const before = t.owner.session.profiles.snapshot();
    expect(before.get(t.other.pubkey)?.name).toBe("Other");
    const changed = vi.fn();
    const unsubscribe = t.owner.session.profiles.subscribe(changed);
    const directory = Array.from({ length: 1030 }, (_, i) =>
      profile(keypair(), { name: `Directory ${i}` }),
    );
    t.query.mockImplementation(async (filters) => {
      const filter = filters[0];
      const start = ((filter?.page ?? 1) - 1) * (filter?.limit ?? 100);
      return directory.slice(start, start + (filter?.limit ?? 100));
    });
    const signal = new AbortController().signal;
    const seen = new Set<string>();
    for (let page = 1; page <= 36; page++) {
      const result = await t.dm.people("", page, signal);
      for (const person of result.people) seen.add(person.pubkey);
      expect(t.owner.session.profiles.snapshot()).toBe(before);
      if (!result.hasMore) break;
    }
    expect(seen.size).toBe(1030);
    expect(changed).not.toHaveBeenCalled();
    expect(t.owner.session.profiles.snapshot().get(t.other.pubkey)?.name).toBe(
      "Other",
    );
    unsubscribe();
  } finally {
    t.owner.dispose();
  }
});

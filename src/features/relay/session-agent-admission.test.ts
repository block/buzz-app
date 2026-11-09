import { expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { PublishRejected } from "./outbox";
import { NamedError } from "./refusal";
import { keypair, roster, signed } from "./testing";
import { matchesEvent } from "./projection";
import type { RelayEvent } from "./events";
import { SOLO_LABEL } from "../solo/labels";

function setup(visibility: "private" | "public" = "private") {
  const viewer = keypair(),
    relay = keypair(),
    agent = keypair();
  const parent = "11111111-1111-4111-8111-111111111111",
    child = "22222222-2222-4222-8222-222222222222";
  let members = [viewer.pubkey];
  let childMembers = [viewer.pubkey];
  let clock = 1700000000;
  let denied = false;
  let foreignRoster = false;
  let libraryFailure = false;
  let afterPublish = () => {};
  let omitMembership = false;
  let failSaves = false;
  const archived: string[] = [];
  let holdRoster: Promise<void> | undefined;
  let releaseRoster: (() => void) | undefined;
  let rosterStarted: (() => void) | undefined;
  let rosterRequested: Promise<void> | undefined;
  let holdSigning: Promise<void> | undefined;
  let releaseSigning: (() => void) | undefined;
  let signingStarted: (() => void) | undefined;
  let signingRequested: Promise<void> | undefined;
  const sign = vi.fn(async (template: Parameters<typeof signed>[1]) => {
    if (template.kind === 9000 && holdSigning) {
      signingStarted?.();
      await holdSigning;
    }
    return signed(viewer, template);
  });
  const secondAgent = keypair().pubkey;
  const meta = (id: string, type: string, extra: string[][] = []) =>
    signed(relay, {
      kind: 39000,
      content: "",
      tags: [["d", id], ["t", type], ["name", id], ...extra],
    });
  const publish = vi.fn(async (_event: RelayEvent) => {
    const target = _event.tags.find(([name]) => name === "h")?.[1];
    if (denied)
      throw new PublishRejected(
        "restricted: only channel admins can add agents",
      );
    if (!omitMembership && target === parent)
      members = [viewer.pubkey, agent.pubkey];
    if (!omitMembership && target === child)
      childMembers = [viewer.pubkey, agent.pubkey];
    clock++;
    afterPublish();
  });
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      archiveAuthority: relay.pubkey,
      media: () => undefined,
      readAgentLibrary: async () => {
        if (libraryFailure) throw new Error("Fixture library unavailable");
        return {
          definitions: [],
          identities: [
            { pubkey: agent.pubkey, name: "Outside agent" },
            { pubkey: secondAgent, name: "Second agent" },
          ],
        };
      },
      writer: {
        kinds: [9, 9000, 9007],
        sign,
        publish,
      },
      query: async (filters) => {
        if (
          holdRoster &&
          filters.some(
            (filter) =>
              filter.kinds?.includes(39002) && filter["#d"]?.includes(parent),
          )
        ) {
          rosterStarted?.();
          await holdRoster;
        }
        if (
          libraryFailure &&
          filters.some((filter) => filter.kinds?.includes(30177))
        )
          throw new Error("Fixture inventory unavailable");
        if (foreignRoster && filters.some((filter) => filter["#d"]))
          return [
            roster(agent, child, [viewer.pubkey, agent.pubkey], clock + 1),
          ];
        const events = [
          signed(relay, {
            kind: 13535,
            created_at: clock,
            content: "",
            tags: [["-"], ...archived.map((key) => ["p", key])],
          }),
          meta(parent, "stream"),
          meta(child, "stream", [
            [visibility],
            ["t", SOLO_LABEL],
            ["join_role", "guest"],
          ]),
          roster(relay, parent, members, clock),
          roster(relay, child, childMembers, clock),
        ];
        return events.filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
      },
    },
    {
      outboxStorage: {
        load: () => [],
        save: () => {
          if (failSaves) throw new Error("Storage unavailable");
        },
      },
    },
  );
  return {
    owner,
    failSaves: (value: boolean) => {
      failSaves = value;
    },
    parent,
    child,
    agent: agent.pubkey,
    secondAgent,
    archive: (key: string) => {
      clock++;
      archived.push(key);
    },
    returnForeignRoster: () => {
      foreignRoster = true;
    },
    failLibraryRefresh: () => {
      libraryFailure = true;
    },
    afterPublish: (callback: () => void) => {
      afterPublish = callback;
    },
    publish,
    sign,
    omitMembership: () => {
      omitMembership = true;
    },
    holdRoster: () => {
      rosterRequested = new Promise<void>((resolve) => {
        rosterStarted = resolve;
      });
      holdRoster = new Promise<void>((resolve) => {
        releaseRoster = resolve;
      });
      return rosterRequested;
    },
    releaseRoster: () => releaseRoster?.(),
    holdSigning: () => {
      signingRequested = new Promise<void>((resolve) => {
        signingStarted = resolve;
      });
      holdSigning = new Promise<void>((resolve) => {
        releaseSigning = resolve;
      });
      return signingRequested;
    },
    releaseSigning: () => releaseSigning?.(),
    setDenied: (value: boolean) => {
      denied = value;
    },
    async ready() {
      owner.session.channels.ensureList();
      await vi.waitFor(() =>
        expect(
          owner.session.channels
            .list()
            .channels.find((item) => item.id === child)?.channelType,
        ).toBe("solo"),
      );
      await owner.session.agentLibrary.refresh();
    },
  };
}

it.each(["private", "public"] as const)(
  "adds an outside agent as Bot with a Guest default in a %s Solo chat",
  async (visibility) => {
    const test = setup(visibility);
    try {
      await test.ready();
      await test.owner.session.channelWrites.addAgents(test.child, [
        test.agent,
        test.agent,
      ]);
      expect(test.publish).toHaveBeenCalledOnce();
      expect(test.publish.mock.calls[0]?.[0]).toMatchObject({
        kind: 9000,
        tags: expect.arrayContaining([
          ["h", test.child],
          ["p", test.agent],
          ["role", "bot"],
        ]),
      });
      expect(
        test.owner.session.channels
          .list()
          .channels.find((item) => item.id === test.child)?.members,
      ).toContain(test.agent);
      await test.owner.session.channelWrites.addAgents(test.child, [
        test.agent,
      ]);
      expect(test.publish).toHaveBeenCalledOnce();
    } finally {
      test.owner.dispose();
    }
  },
);
it.each([
  { roleTags: [] },
  { roleTags: [["role", "guest"]] },
  { roleTags: [["role", "member"]] },
  {
    roleTags: [
      ["role", "bot"],
      ["role", "bot"],
    ],
  },
])(
  "does not reuse a Solo agent receipt with incompatible role tags $roleTags",
  async ({ roleTags }) => {
    const test = setup();
    try {
      await test.ready();
      test.setDenied(true);
      const outbox = test.owner.session.outbox;
      if (!outbox) throw new Error("Missing fixture outbox");
      const previous = outbox.send({
        kind: 9000,
        content: "",
        tags: [["h", test.child], ["p", test.agent], ...roleTags],
      });
      await vi.waitFor(() =>
        expect(
          outbox.snapshot().find((item) => item.event.id === previous)
            ?.delivery,
        ).toBe("failed"),
      );
      test.setDenied(false);
      await test.owner.session.channelWrites.addAgents(test.child, [
        test.agent,
      ]);
      expect(test.publish.mock.lastCall?.[0].id).not.toBe(previous);
      expect(test.publish.mock.lastCall?.[0].tags).toContainEqual([
        "role",
        "bot",
      ]);
    } finally {
      test.owner.dispose();
    }
  },
);
it("reports channel-specific uncertainty when an accepted addition lacks roster confirmation", async () => {
  const test = setup();
  try {
    await test.ready();
    test.omitMembership();
    vi.useFakeTimers();
    const adding = test.owner.session.channelWrites.addAgents(test.parent, [
      test.agent,
    ]);
    const result = expect(adding).rejects.toThrow(
      "Buzz hasn’t seen the agent join yet. Try again in a moment. Buzz won’t add them twice.",
    );
    await vi.waitFor(() => expect(test.publish).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(15000);
    await result;
  } finally {
    vi.useRealTimers();
    test.owner.dispose();
  }
});

it("keeps channel permission failures and retries the same saved invitation", async () => {
  const test = setup();
  try {
    await test.ready();
    test.setDenied(true);
    await expect(
      test.owner.session.channelWrites.addAgents(test.child, [test.agent]),
    ).rejects.toThrow("You don’t have permission.");
    expect(
      test.owner.session.channels
        .list()
        .channels.find((item) => item.id === test.child)?.members,
    ).not.toContain(test.agent);
    const first = test.publish.mock.calls[0]?.[0].id;
    test.setDenied(false);
    await test.owner.session.channelWrites.addAgents(test.child, [test.agent]);
    expect(test.publish.mock.calls[1]?.[0].id).toBe(first);
    expect(test.publish).toHaveBeenCalledTimes(2);
  } finally {
    test.owner.dispose();
  }
});
it("replaces an expired failed invitation with a new one", async () => {
  const test = setup();
  try {
    await test.ready();
    test.setDenied(true);
    const now = Date.now;
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      await expect(
        test.owner.session.channelWrites.addAgents(test.parent, [test.agent]),
      ).rejects.toThrow("You don’t have permission.");
      expect(test.publish).toHaveBeenCalledOnce();
      vi.mocked(Date.now).mockReturnValue(1_700_000_901_000);
      test.setDenied(false);
      // The relay no longer takes the old one, so Buzz sends a new one.
      const first = test.publish.mock.calls[0]?.[0].id;
      await test.owner.session.channelWrites.addAgents(test.parent, [
        test.agent,
      ]);
      expect(test.publish).toHaveBeenCalledTimes(2);
      expect(test.publish.mock.calls[1]?.[0].id).not.toBe(first);
      expect(
        test.owner.session.outbox
          ?.snapshot()
          .some((item) => item.event.id === first),
      ).toBe(false);
    } finally {
      vi.restoreAllMocks();
      expect(Date.now).toBe(now);
    }
  } finally {
    test.owner.dispose();
  }
});

it("names the agent when the invitation replacing an expired one is refused again, without Retry", async () => {
  const test = setup();
  try {
    await test.ready();
    test.setDenied(true);
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    await expect(
      test.owner.session.channelWrites.addAgents(test.parent, [test.agent]),
    ).rejects.toThrow("You don’t have permission.");
    const first = test.publish.mock.calls[0]?.[0].id;
    vi.mocked(Date.now).mockReturnValue(1_700_000_901_000);
    const error = await test.owner.session.channelWrites
      .addAgents(test.parent, [test.agent])
      .catch((error: unknown) => error);
    // Name first, then why: as Manage members names each person.
    expect(error).toBeInstanceOf(NamedError);
    expect(error).toMatchObject({
      message: "Buzz couldn’t add Outside agent. You don’t have permission.",
      final: true,
    });
    expect(test.publish).toHaveBeenCalledTimes(2);
    expect(test.publish.mock.calls[1]?.[0].id).not.toBe(first);
  } finally {
    vi.restoreAllMocks();
    test.owner.dispose();
  }
});

it("says to add the agent again when the expired invitation can't be cleared", async () => {
  const test = setup();
  try {
    await test.ready();
    test.setDenied(true);
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    await expect(
      test.owner.session.channelWrites.addAgents(test.parent, [test.agent]),
    ).rejects.toThrow("You don’t have permission.");
    const first = test.publish.mock.calls[0]?.[0].id;
    vi.mocked(Date.now).mockReturnValue(1_700_000_901_000);
    test.setDenied(false);
    test.failSaves(true);
    const error = await test.owner.session.channelWrites
      .addAgents(test.parent, [test.agent])
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(NamedError);
    expect(error).toMatchObject({
      message: "Buzz couldn’t add Outside agent. Try adding them again.",
      final: false,
    });
    // Nothing new is sent while the old request is still there.
    expect(test.publish).toHaveBeenCalledOnce();
    expect(
      test.owner.session.outbox
        ?.snapshot()
        .some((item) => item.event.id === first),
    ).toBe(true);
    test.failSaves(false);
    await test.owner.session.channelWrites.addAgents(test.parent, [test.agent]);
    expect(test.publish).toHaveBeenCalledTimes(2);
  } finally {
    vi.restoreAllMocks();
    test.owner.dispose();
  }
});

it("rejects nonmember identities outside the agent library before adding anyone", async () => {
  const test = setup();
  try {
    await test.ready();
    await expect(
      test.owner.session.channelWrites.addAgents(test.parent, [
        test.agent,
        "f".repeat(64),
      ]),
    ).rejects.toThrow(/agent library/);
    expect(test.publish).not.toHaveBeenCalled();
  } finally {
    test.owner.dispose();
  }
});

it("rejects a known-archived library agent before adding it to a session", async () => {
  const test = setup();
  try {
    await test.ready();
    test.archive(test.agent);
    await test.owner.session.archives.ensure();
    expect(test.owner.session.archives.state(test.agent)).toBe("archived");
    await expect(
      test.owner.session.channelWrites.addAgents(test.child, [test.agent]),
    ).rejects.toThrow(/archived/);
    expect(test.publish).not.toHaveBeenCalled();
  } finally {
    test.owner.dispose();
  }
});

it("rejects a stale cached identity after the current library refresh fails", async () => {
  const test = setup();
  try {
    await test.ready();
    test.failLibraryRefresh();
    await test.owner.session.agentLibrary.refresh();
    const library = test.owner.session.agentLibrary.snapshot();
    expect(library.status).toBe("error");
    expect(library.identities.map((identity) => identity.pubkey)).toContain(
      test.agent,
    );
    await expect(
      test.owner.session.channelWrites.addAgents(test.parent, [test.agent]),
    ).rejects.toThrow(/agent library/);
    expect(test.publish).not.toHaveBeenCalled();
  } finally {
    test.owner.dispose();
  }
});

it("stops additional invitations when the composing view closes during admission", async () => {
  const test = setup();
  let active = true;
  try {
    await test.ready();
    test.afterPublish(() => {
      active = false;
    });
    await expect(
      test.owner.session.channelWrites.addAgents(
        test.child,
        [test.agent, test.secondAgent],
        () => active,
      ),
    ).rejects.toThrow(/cancelled/);
    expect(test.publish).toHaveBeenCalledOnce();
    expect(test.publish.mock.calls[0]?.[0].tags).toContainEqual([
      "p",
      test.agent,
    ]);
  } finally {
    test.owner.dispose();
  }
});

it("does not accept a foreign-signed roster as fresh membership", async () => {
  const test = setup();
  try {
    await test.ready();
    test.returnForeignRoster();
    await expect(
      test.owner.session.channelWrites.addAgents(test.child, [test.agent]),
    ).rejects.toThrow(/can’t check who’s in this channel/);
    expect(test.publish).not.toHaveBeenCalled();
  } finally {
    test.owner.dispose();
  }
});

it.each(["roster", "signing"])(
  "stops admission after native evidence disappears at the %s boundary",
  async (boundary) => {
    const test = setup();
    let active = true;
    try {
      await test.ready();
      const started =
        boundary === "roster" ? test.holdRoster() : test.holdSigning();
      const admission = test.owner.session.channelWrites.addAgents(
        test.parent,
        [test.agent],
        () => active,
      );
      await started;
      active = false; // Legacy choice remains available to the broad session API.
      if (boundary === "roster") test.releaseRoster();
      else test.releaseSigning();
      await expect(admission).rejects.toThrow(/cancelled/);
      expect(test.publish).not.toHaveBeenCalled();
      if (boundary === "roster") expect(test.sign).not.toHaveBeenCalled();
      else expect(test.sign).toHaveBeenCalledOnce();
    } finally {
      test.releaseRoster();
      test.releaseSigning();
      test.owner.dispose();
    }
  },
);

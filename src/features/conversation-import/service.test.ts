import { Context } from "@deepseek-ai/cordis";
import { getEventHash } from "nostr-tools";
import { afterEach, expect, it, vi } from "vitest";
import { eventDto, type RelayEvent, type ReadFilter } from "../relay/events";
import { registerImportWriter } from "../relay/import-writes";
import type { OutgoingEvent } from "../relay/outbox";
import type { RelayData } from "../relay/service";
import { keypair, signed } from "../relay/testing";
import { proposalTemplate } from "./protocol";
import { createImportReviews, type ImportReview } from "./reviews";
import { createConversationImportHost } from "./service";
import type {
  ConversationImportService,
  ImportProposalInput,
  PreparedImportEvent,
} from "./types";

const authority = keypair();
const viewer = "a".repeat(64);
const partner = "b".repeat(64);
const outsider = "9".repeat(64);
const channel = "f0".repeat(16);
const now = 1_740_000_000;
const origin = "https://relay.example";

const proposalInput: ImportProposalInput = {
  channelId: channel,
  source: {
    type: "slack",
    conversation: "e".repeat(64),
    kind: "dm",
    label: "Direct message",
  },
  range: { from: 1_735_689_600, to: 1_735_776_000 },
  participants: [
    { pubkey: viewer, source_user: "2".repeat(64), messages: 3, reactions: 0 },
    { pubkey: partner, source_user: "3".repeat(64), messages: 1, reactions: 0 },
  ],
  excluded_authors: 0,
  manifest: "d".repeat(64),
  expires_at: now + 86_400,
};

function stamp(
  pubkey: string,
  template: { kind: number; content: string; tags: string[][] },
  created_at = now - 60,
) {
  const unsigned = { ...template, pubkey, created_at };
  return {
    ...unsigned,
    id: getEventHash(unsigned),
    sig: "0".repeat(128),
  } as RelayEvent;
}

function proposalFor(kind: ImportProposalInput["source"]["kind"]) {
  return stamp(
    viewer,
    proposalTemplate({
      ...proposalInput,
      source: { ...proposalInput.source, kind },
    }),
  );
}

const proposal = proposalFor("dm");

function verifiedRecord(pubkey: string, username: string, displayName: string) {
  return eventDto(
    signed(authority, {
      kind: 30382,
      content: "",
      tags: [
        ["d", pubkey],
        ["p", pubkey],
        ["active", "true"],
        ["display_name", displayName],
        ["username", username],
        ["issuer_label", "Example Directory"],
        ["verified_at", "1699999000"],
      ],
    }),
  );
}

function snapshotRecord(proposalId: string, status: string) {
  return eventDto(
    signed(authority, {
      kind: 30623,
      content: JSON.stringify({
        v: 1,
        status,
        required: [viewer, partner],
        consents: { [viewer]: "accept", [partner]: "accept" },
        published: {},
        completed: [],
        expires_at: now + 86_400,
      }),
      tags: [
        ["d", proposalId],
        ["e", proposalId],
        ["h", channel],
        ["p", viewer],
        ["p", partner],
      ],
    }),
  );
}

function rosterRecord(channelId: string, members: readonly string[]) {
  return eventDto(
    signed(authority, {
      kind: 39002,
      content: "",
      tags: [["d", channelId], ...members.map((key) => ["p", key])],
    }),
  );
}

type Decision = Pick<OutgoingEvent, "delivery"> & {
  error?: string;
  reason?: string;
};

type Channel = {
  id: string;
  name: string;
  channelType: "dm" | "stream" | "forum";
  members: string[];
  archived: boolean;
  visibility?: "private" | "public";
  viewerRole?: string;
};

function setup(
  options: {
    verified?: readonly string[];
    status?: string;
    proposal?: RelayEvent;
    decide?: (event: RelayEvent) => Decision | Promise<Decision>;
    existing?: (id: string, reads: number) => boolean;
    supported?: boolean;
    channel?: Partial<Channel>;
    roster?: (channelId: string) => readonly string[] | undefined;
  } = {},
) {
  const current = options.proposal ?? proposal;
  const items: OutgoingEvent[] = [];
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const decide = options.decide ?? (() => ({ delivery: "accepted" as const }));
  const settle = (event: RelayEvent) => {
    queueMicrotask(async () => {
      const outcome = await decide(event);
      const index = items.findIndex((item) => item.event.id === event.id);
      if (index < 0) return;
      items[index] = { ...(items[index] as OutgoingEvent), ...outcome };
      notify();
    });
  };
  const enqueue = (event: RelayEvent) => {
    if (items.some((item) => item.event.id === event.id)) return event.id;
    items.push({ event, delivery: "sending" } as OutgoingEvent);
    settle(event);
    return event.id;
  };
  const sent: RelayEvent[] = [];
  const records: RelayEvent[] = [];
  const writer = {
    sendAt: vi.fn((input: PreparedImportEvent) => {
      const event = stamp(
        viewer,
        { ...input, tags: input.tags.map((tag) => [...tag]) },
        input.created_at,
      );
      sent.push(event);
      return enqueue(event);
    }),
    sendRecord: vi.fn(
      (input: { kind: number; content: string; tags: string[][] }) => {
        const event = stamp(viewer, input, now);
        records.push(event);
        return enqueue(event);
      },
    ),
    retry: vi.fn((id: string) => {
      const item = items.find((entry) => entry.event.id === id);
      if (item) {
        Object.assign(item, { delivery: "sending" });
        settle(item.event as RelayEvent);
      }
    }),
    dismiss: vi.fn(async (id: string) => {
      const index = items.findIndex((item) => item.event.id === id);
      if (index >= 0) items.splice(index, 1);
      notify();
    }),
    local: {
      snapshot: () => items,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
  const verified = options.verified ?? [viewer, partner];
  const target: Channel = {
    id: channel,
    name: "dm",
    channelType: "dm",
    members: [viewer, partner],
    archived: false,
    ...options.channel,
  };
  const channels: Channel[] = [target];
  const parentReads = new Map<string, number>();
  const snapshotRead = vi.fn(async (filters: readonly ReadFilter[]) => {
    const filter = filters[0] as ReadFilter & Record<string, unknown>;
    if (filter.kinds?.includes(30382))
      return verified
        .filter((key) => (filter["#d"] as string[]).includes(key))
        .map((key) =>
          verifiedRecord(
            key,
            key === viewer ? "viewer" : "partner",
            key === viewer ? "Viewer Person" : "Partner Person",
          ),
        );
    if (filter.kinds?.includes(30623))
      return options.status
        ? [snapshotRecord((filter["#d"] as string[])[0] ?? "", options.status)]
        : [];
    if (filter.kinds?.includes(39002)) {
      const id = (filter["#d"] as string[])[0] ?? "";
      const members =
        options.roster?.(id) ??
        channels.find((item) => item.id === id)?.members;
      return members ? [rosterRecord(id, members)] : [];
    }
    if (filter.ids?.includes(current.id)) return [current];
    if (filter.kinds?.includes(42110)) return [current];
    if (filter.kinds?.includes(9)) return [];
    const id = filter.ids?.[0];
    if (id) {
      const reads = (parentReads.get(id) ?? 0) + 1;
      parentReads.set(id, reads);
      return options.existing?.(id, reads)
        ? [
            stamp(partner, { kind: 9, content: "x", tags: [["h", channel]] }),
          ].map((event) => ({ ...event, id }))
        : [];
    }
    return [];
  });
  const uploads: File[] = [];
  const upload = vi.fn(
    async (file: File, _channelId: string, _signal: AbortSignal) => {
      uploads.push(file);
      return {
        name: file.name,
        url: `${origin}/media/${"c".repeat(64)}.png`,
        type: file.type,
        size: file.size,
        sha256: "c".repeat(64),
      };
    },
  );
  const session = {
    viewer,
    relayAuthor: authority.pubkey,
    scope: `${origin}:${viewer}`,
    conversationImport: options.supported ?? true,
    snapshotRead,
    subscribeLive: () => () => {},
    searchProfiles: vi.fn(async () => []),
    channels: { list: () => ({ channels }) },
    profiles: {
      snapshot: () => new Map(),
      ensure: async () => {},
      subscribe: () => () => {},
    },
    attachments: { upload },
    directMessages: {
      open: vi.fn(async () => {
        const id = "d0".repeat(16);
        channels.push({
          id,
          name: "dm",
          channelType: "dm",
          members: [viewer, outsider],
          archived: false,
        });
        return id;
      }),
    },
    channelCreation: {
      create: vi.fn(async () => {
        const id = "c0".repeat(16);
        channels.push({
          id,
          name: "imported",
          channelType: "stream",
          members: [viewer],
          archived: false,
          visibility: "private",
        });
        return id;
      }),
    },
    memberAdditions: {
      add: vi.fn(async (id: string, pubkey: string) => {
        channels.find((item) => item.id === id)?.members.push(pubkey);
      }),
    },
  };
  registerImportWriter(session, writer as never);
  const relay = {
    snapshot: () => ({ session, status: "ready", viewer }),
    subscribe: () => () => {},
  } as unknown as RelayData;
  const reviews = createImportReviews();
  const waits: number[] = [];
  const expiries: (() => void)[] = [];
  const ctx = new Context();
  const service = createConversationImportHost(ctx, relay, reviews, {
    now: () => now,
    clock: () => 0,
    wait: async (ms, signal) => {
      waits.push(ms);
      // The give-up wait after a stop resolves only when a test expires it.
      if (ms === 30_000)
        await new Promise<void>((resolve, reject) => {
          expiries.push(resolve);
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
    },
  });
  contexts.push(ctx);
  return {
    ctx,
    service,
    relay,
    reviews,
    writer,
    items,
    listeners,
    expiries,
    sent,
    records,
    waits,
    snapshotRead,
    target,
    channels,
    session,
    upload,
    uploads,
    proposal: current,
  };
}

const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
});

function message(
  created_at: number,
  ref: string,
  parent?: string,
  proposalId = proposal.id,
): PreparedImportEvent {
  return {
    kind: 9,
    created_at,
    tags: [
      ["h", channel],
      ...(parent ? [["e", parent, "", "reply"]] : []),
      ["import", proposalId],
      ["source", "slack", ref],
    ],
    content: `Message ${ref}`,
  };
}

async function nextReview(reviews: ReturnType<typeof createImportReviews>) {
  await vi.waitFor(() => expect(reviews.snapshot()).toHaveLength(1));
  return reviews.snapshot()[0] as ImportReview;
}

it("computes NIP-01 ids for plugin-derived parents", () => {
  const { service } = setup();
  expect(
    service.eventId({
      pubkey: viewer,
      created_at: 1_735_732_800,
      kind: 9,
      tags: [
        ["h", channel],
        ["import", "1".repeat(64)],
        ["source", "slack", "1735732800.000100"],
      ],
      content: 'Hello "world"\nline two é 😀',
    }),
  ).toBe("8700e9d79a391c7bde29babf26fd2167e00335bafa08abfc8e21ea34b68268e4");
});

it("gives an injected plugin no path to the host state or dialogs", async () => {
  const { ctx, relay, reviews, service } = setup();
  let injected!: ConversationImportService;
  await ctx.plugin({
    inject: ["conversationImport"],
    apply(plugin: Context) {
      injected = plugin.conversationImport;
    },
  });
  expect(injected).toBeDefined();
  const reachable = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (!value || (typeof value !== "object" && typeof value !== "function"))
      return;
    if (reachable.has(value) || depth > 2) return;
    reachable.add(value);
    for (const key of Reflect.ownKeys(value)) {
      let child: unknown;
      try {
        child = (value as Record<PropertyKey, unknown>)[key];
      } catch {
        continue;
      }
      visit(child, depth + 1);
    }
  };
  let object: object | null = injected as object;
  while (object && object !== Object.prototype) {
    for (const key of Reflect.ownKeys(object)) {
      let value: unknown;
      try {
        value = (injected as unknown as Record<PropertyKey, unknown>)[key];
      } catch {
        continue;
      }
      if (key === "constructor" && typeof value === "function") {
        const Host = value as new (...args: unknown[]) => unknown;
        const lookalike = {
          request: async () => true,
          snapshot: () => [],
          subscribe: () => () => {},
        };
        const fake = { reflect: { provide() {} }, effect() {} };
        expect(() => new Host(fake, relay, lookalike)).toThrow(
          "Conversation import is provided by the host.",
        );
        expect(() => new Host(fake, relay, reviews, {})).toThrow(
          "Conversation import is provided by the host.",
        );
        expect(() => Reflect.construct(Host, [fake, relay, reviews])).toThrow(
          "Conversation import is provided by the host.",
        );
      } else if (typeof value === "function" && value.length === 0)
        try {
          visit(Reflect.apply(value, injected, []), 0);
        } catch {}
      visit(value, 0);
    }
    object = Object.getPrototypeOf(object);
  }
  expect(reachable.has(reviews)).toBe(false);
  for (const value of reachable)
    expect(value && typeof value === "object" && "reviews" in value).toBe(
      false,
    );
  expect("state" in injected).toBe(false);
  expect((service as unknown as { state?: unknown }).state).toBeUndefined();
});

it("publishes paced events in order and reports their ids", async () => {
  const { service, sent, waits } = setup({ status: "active" });
  const events = [
    message(1_735_732_800, "1"),
    message(1_735_732_801, "2"),
    message(1_735_732_802, "3"),
  ];
  const progress = vi.fn();
  const report = await service.publish(proposal.id, events, {
    onProgress: progress,
  });
  expect(report.status).toBe("done");
  expect(report.ids).toEqual(sent.map((event) => event.id));
  expect(report.ids[0]).toBe(
    service.eventId({ ...(events[0] as PreparedImportEvent), pubkey: viewer }),
  );
  expect(waits).toEqual([125, 125]);
  expect(progress).toHaveBeenLastCalledWith({ published: 3, total: 3 });
});

it("stops on the first rejection, surfaces the relay text verbatim and dismisses the refused event", async () => {
  let count = 0;
  const { service, sent, writer, items } = setup({
    status: "active",
    decide: () =>
      ++count === 2
        ? {
            delivery: "failed",
            error: "invalid: import per-author message count exceeded",
          }
        : { delivery: "accepted" },
  });
  const report = await service.publish(
    proposal.id,
    [
      message(1_735_732_800, "1"),
      message(1_735_732_801, "2"),
      message(1_735_732_802, "3"),
    ],
    {},
  );
  expect(report).toMatchObject({
    status: "rejected",
    published: 1,
    stoppedAt: 1,
    reason: "invalid: import per-author message count exceeded",
  });
  expect(sent).toHaveLength(2);
  expect(writer.dismiss).toHaveBeenCalledWith(sent[1]?.id);
  expect(items.map((item) => item.event.id)).toEqual([sent[0]?.id]);
});

it("waits out a rate limit and retries through the host writer", async () => {
  let count = 0;
  const { service, writer, waits } = setup({
    status: "active",
    decide: () =>
      ++count === 1
        ? { delivery: "failed", error: "rate-limited: slow down" }
        : { delivery: "accepted" },
  });
  const report = await service.publish(
    proposal.id,
    [message(1_735_732_800, "1")],
    {},
  );
  expect(report.status).toBe("done");
  expect(writer.retry).toHaveBeenCalledOnce();
  expect(waits).toContain(15_000);
});

it("waits for another participant's parent, polling every five seconds", async () => {
  const parent = "9".repeat(64);
  const { service, waits, sent } = setup({
    status: "active",
    existing: (id, reads) => id === parent && reads >= 3,
  });
  const progress = vi.fn();
  const report = await service.publish(
    proposal.id,
    [message(1_735_732_800, "1"), message(1_735_732_900, "2", parent)],
    { onProgress: progress },
  );
  expect(report.status).toBe("done");
  expect(sent).toHaveLength(2);
  expect(waits.filter((ms) => ms === 5_000)).toHaveLength(2);
  expect(progress).toHaveBeenCalledWith(
    expect.objectContaining({ waitingFor: expect.any(String) }),
  );
});

it("rejects events that break the import rules before publishing any", async () => {
  const { service, sent } = setup({ status: "active" });
  const bad = {
    ...message(1_735_732_801, "2"),
    tags: [
      ["h", channel],
      ["source", "slack", "2"],
    ],
  };
  const report = await service.publish(
    proposal.id,
    [message(1_735_732_800, "1"), bad],
    {},
  );
  expect(report.status).toBe("rejected");
  expect(report.stoppedAt).toBe(1);
  expect(sent).toHaveLength(0);
  const future = await service.publish(
    proposal.id,
    [message(now + 10, "3")],
    {},
  );
  expect(future.status).toBe("rejected");
});

it("does not publish when the relay says the session is not active", async () => {
  const { service, sent } = setup({ status: "withdrawn" });
  const report = await service.publish(
    proposal.id,
    [message(1_735_732_800, "1")],
    {},
  );
  expect(report).toMatchObject({
    status: "stopped",
    reason: "This import is withdrawn.",
  });
  expect(sent).toHaveLength(0);
});

it("does not publish without a relay snapshot", async () => {
  const { service, sent } = setup();
  const report = await service.publish(
    proposal.id,
    [message(1_735_732_800, "1")],
    {},
  );
  expect(report).toMatchObject({
    status: "stopped",
    published: 0,
    reason: "The relay has not confirmed that this import is active.",
  });
  expect(sent).toHaveLength(0);
});

it("refuses to propose on a relay that does not advertise NIP-CI", async () => {
  const { service, reviews, writer } = setup({ supported: false });
  await expect(service.propose(proposalInput)).rejects.toThrow(
    "This community's relay does not support conversation import.",
  );
  expect(reviews.snapshot()).toHaveLength(0);
  expect(writer.sendRecord).not.toHaveBeenCalled();
});

it("refuses consent on a relay that does not advertise NIP-CI", async () => {
  const { service, reviews, writer } = setup({
    supported: false,
    status: "proposed",
  });
  await expect(
    service.consent(proposal.id, "accept", "2".repeat(64)),
  ).rejects.toThrow(
    "This community's relay does not support conversation import.",
  );
  expect(reviews.snapshot()).toHaveLength(0);
  expect(writer.sendRecord).not.toHaveBeenCalled();
});

it("gives a session's writer only to the first host, and refuses lookalike reviews", async () => {
  const { relay, reviews, writer, service } = setup({ status: "proposed" });
  service.membership(channel);
  const second = new Context();
  contexts.push(second);
  const rival = createConversationImportHost(
    second,
    relay,
    createImportReviews(),
  );
  await expect(
    rival.consent(proposal.id, "accept", "2".repeat(64)),
  ).rejects.toThrow("This connection cannot publish conversation imports.");
  expect(writer.sendRecord).not.toHaveBeenCalled();
  expect(reviews.snapshot()).toHaveLength(0);
  expect(() =>
    createConversationImportHost(new Context(), relay, {
      ...reviews,
    } as typeof reviews),
  ).toThrow("Conversation import is provided by the host.");
});

it("refuses a proposal when a participant has no verified identity", async () => {
  const { service, reviews, writer } = setup({ verified: [viewer] });
  const pending = service.propose(proposalInput);
  const review = await nextReview(reviews);
  expect(review.type).toBe("propose");
  expect(review.refusal).toMatch("no verified Buzz identity");
  reviews.approve(review.id);
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(writer.sendRecord).not.toHaveBeenCalled();
});

it("refuses a direct message proposal whose participants differ from the members", async () => {
  const { service, reviews } = setup();
  const pending = service.propose({
    ...proposalInput,
    participants: [proposalInput.participants[0] as never],
  });
  const review = await nextReview(reviews);
  expect(review.refusal).toBeDefined();
  reviews.dismiss(review.id);
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

it("refuses private and public channel proposals into the wrong destination", async () => {
  const privateSource = {
    ...proposalInput,
    source: { ...proposalInput.source, kind: "private_channel" as const },
  };
  const wrong = setup({
    channel: { channelType: "stream", visibility: "public", name: "general" },
  });
  const pending = wrong.service.propose(privateSource);
  const review = await nextReview(wrong.reviews);
  expect(review.refusal).toBe(
    "A private channel can only be imported into a private channel.",
  );
  wrong.reviews.dismiss(review.id);
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });

  const extra = setup({
    channel: {
      channelType: "stream",
      visibility: "private",
      members: [viewer, partner, outsider],
    },
  });
  const extraPending = extra.service.propose(privateSource);
  const extraReview = await nextReview(extra.reviews);
  expect(extraReview.refusal).toBe(
    "One member of the destination is not in the source channel.",
  );
  extra.reviews.dismiss(extraReview.id);
  await expect(extraPending).rejects.toMatchObject({ name: "AbortError" });

  const publicSource = {
    ...proposalInput,
    source: { ...proposalInput.source, kind: "public_channel" as const },
  };
  const closed = setup({
    channel: { channelType: "stream", visibility: "private" },
  });
  const closedPending = closed.service.propose(publicSource);
  const closedReview = await nextReview(closed.reviews);
  expect(closedReview.refusal).toBe(
    "A public channel can only be imported into a public channel.",
  );
  closed.reviews.dismiss(closedReview.id);
  await expect(closedPending).rejects.toMatchObject({ name: "AbortError" });

  const open = setup({
    channel: {
      channelType: "stream",
      visibility: "public",
      name: "general",
      members: [viewer, partner, outsider],
    },
  });
  const openPending = open.service.propose(publicSource);
  const openReview = await nextReview(open.reviews);
  expect(openReview.refusal).toBeUndefined();
  expect(
    openReview.facts.find((fact) => fact.label === "Destination")?.value,
  ).toBe("#general (public channel)");
  open.reviews.dismiss(openReview.id);
  await expect(openPending).rejects.toMatchObject({ name: "AbortError" });
});

it("publishes a proposal only after the dialog is approved", async () => {
  const { service, reviews, writer } = setup();
  const pending = service.propose(proposalInput);
  const review = await nextReview(reviews);
  expect(review.refusal).toBeUndefined();
  expect(review.members.map((item) => item.verified?.username)).toEqual([
    "viewer",
    "partner",
  ]);
  expect(review.facts.find((fact) => fact.label === "Manifest")?.value).toBe(
    "dddddddd dddddddd dddddddd dddddddd dddddddd dddddddd dddddddd dddddddd",
  );
  expect(review.facts.find((fact) => fact.label === "Destination")?.value).toBe(
    "Direct message with Partner Person",
  );
  expect(writer.sendRecord).not.toHaveBeenCalled();
  reviews.approve(review.id);
  const { proposalId } = await pending;
  expect(writer.sendRecord).toHaveBeenCalledOnce();
  expect(writer.sendRecord.mock.calls[0]?.[0]).toEqual(
    proposalTemplate(proposalInput),
  );
  expect(proposalId).toMatch(/^[0-9a-f]{64}$/);
});

it("sends nothing when the destination changes while the dialog is open", async () => {
  const { service, reviews, writer, target } = setup({ status: "proposed" });
  const pending = service.propose(proposalInput);
  const review = await nextReview(reviews);
  target.members.push(outsider);
  reviews.approve(review.id);
  await expect(pending).rejects.toThrow(
    "The destination conversation changed while the dialog was open. Nothing was sent.",
  );
  target.members.pop();
  const consent = service.consent(proposal.id, "accept", "2".repeat(64));
  const consentReview = await nextReview(reviews);
  target.channelType = "stream";
  reviews.approve(consentReview.id);
  await expect(consent).rejects.toThrow("Nothing was sent.");
  expect(writer.sendRecord).not.toHaveBeenCalled();
});

it("shows the consent statement, destination and time, and binds the source identity", async () => {
  const { service, reviews, writer } = setup({ status: "proposed" });
  await expect(
    service.consent(proposal.id, "accept", "9".repeat(64)),
  ).rejects.toThrow("does not match");
  const pending = service.consent(proposal.id, "accept", "2".repeat(64));
  const review = await nextReview(reviews);
  expect(review.statement).toBe(
    "Your own messages from this source will be published by you, at their original times.",
  );
  expect(review.facts.find((fact) => fact.label === "Destination")?.value).toBe(
    "Direct message with Partner Person",
  );
  expect(
    review.facts.find((fact) => fact.label === "Estimated time")?.value,
  ).toBe("under a minute");
  reviews.approve(review.id);
  await pending;
  const record = writer.sendRecord.mock.calls[0]?.[0];
  expect(record?.kind).toBe(42111);
  expect(JSON.parse(record?.content ?? "")).toEqual({
    v: 1,
    decision: "accept",
    source_user: "2".repeat(64),
  });
});

it("lets a channel admin approve for a non-participant, and nobody else", async () => {
  const outside = stamp(
    partner,
    proposalTemplate({
      ...proposalInput,
      source: { ...proposalInput.source, kind: "public_channel" },
      participants: [proposalInput.participants[1] as never],
    }),
  );
  const member = setup({
    status: "proposed",
    proposal: outside,
    channel: { channelType: "stream", visibility: "public", name: "general" },
  });
  await expect(
    member.service.consent(outside.id, "accept", "admin"),
  ).rejects.toThrow("You are not a participant in this import.");
  const admin = setup({
    status: "proposed",
    proposal: outside,
    channel: {
      channelType: "stream",
      visibility: "public",
      name: "general",
      viewerRole: "admin",
    },
  });
  const pending = admin.service.consent(outside.id, "accept", "admin");
  const review = await nextReview(admin.reviews);
  expect(review.statement).toBeUndefined();
  admin.reviews.approve(review.id);
  await pending;
  expect(
    JSON.parse(admin.writer.sendRecord.mock.calls[0]?.[0]?.content ?? ""),
  ).toMatchObject({ decision: "accept", source_user: "admin" });
});

it("withdraws and completes with host-signed records", async () => {
  const { service, writer } = setup({ status: "active" });
  await service.withdraw(proposal.id, "Changed my mind");
  await service.complete(proposal.id, { messages: 3, reactions: 0 });
  const [withdrawn, completed] = writer.sendRecord.mock.calls.map(
    (call) => call[0],
  );
  expect(withdrawn?.kind).toBe(42112);
  expect(withdrawn?.tags).toContainEqual(["e", proposal.id]);
  expect(completed?.kind).toBe(42113);
  expect(JSON.parse(completed?.content ?? "")).toMatchObject({
    v: 1,
    published: { messages: 3, reactions: 0 },
  });
});

it("finds verified profiles by username only", async () => {
  const { service } = setup();
  await expect(
    service.findVerified({ email: "someone@example.com" }),
  ).rejects.toThrow("no email");
});

it("stops before signing once someone else joins the destination", async () => {
  let accepted = 0;
  const harness = setup({
    status: "active",
    decide: () => {
      if (++accepted === 1) harness.target.members.push(outsider);
      return { delivery: "accepted" };
    },
  });
  const report = await harness.service.publish(
    proposal.id,
    [message(1_735_732_800, "1"), message(1_735_732_801, "2")],
    {},
  );
  expect(report).toMatchObject({
    status: "stopped",
    published: 1,
    stoppedAt: 1,
    reason: "The destination's members changed. Nothing more was imported.",
  });
  expect(harness.sent).toHaveLength(1);
});

it("stops before signing once the destination's visibility changes", async () => {
  const privateProposal = proposalFor("private_channel");
  let accepted = 0;
  const harness = setup({
    status: "active",
    proposal: privateProposal,
    channel: { channelType: "stream", visibility: "private" },
    decide: () => {
      if (++accepted === 1) harness.target.visibility = "public";
      return { delivery: "accepted" };
    },
  });
  const report = await harness.service.publish(
    privateProposal.id,
    [
      message(1_735_732_800, "1", undefined, privateProposal.id),
      message(1_735_732_801, "2", undefined, privateProposal.id),
    ],
    {},
  );
  expect(report).toMatchObject({
    status: "stopped",
    published: 1,
    stoppedAt: 1,
    reason:
      "The destination's type or visibility changed. Nothing more was imported.",
  });
});

it("bounds an explicit expected member set by the participants", async () => {
  const { service, sent } = setup({ status: "active" });
  const superset = await service.publish(
    proposal.id,
    [message(1_735_732_800, "1")],
    { expectedMembers: [viewer, partner, outsider] },
  );
  expect(superset).toMatchObject({
    status: "rejected",
    reason: "The expected members must match the import's participants.",
  });
  const subset = await service.publish(
    proposal.id,
    [message(1_735_732_800, "1")],
    { expectedMembers: [viewer] },
  );
  expect(subset.status).toBe("rejected");
  expect(sent).toHaveLength(0);
  const ok = await service.publish(proposal.id, [message(1_735_732_800, "1")], {
    expectedMembers: [partner, viewer],
  });
  expect(ok.status).toBe("done");

  const privateProposal = proposalFor("private_channel");
  const narrowed = setup({
    status: "active",
    proposal: privateProposal,
    channel: {
      channelType: "stream",
      visibility: "private",
      members: [viewer],
    },
  });
  const left = await narrowed.service.publish(
    privateProposal.id,
    [message(1_735_732_800, "1", undefined, privateProposal.id)],
    { expectedMembers: [viewer] },
  );
  expect(left.status).toBe("done");
  const widened = await narrowed.service.publish(
    privateProposal.id,
    [message(1_735_732_800, "1", undefined, privateProposal.id)],
    { expectedMembers: [viewer, outsider] },
  );
  expect(widened.reason).toBe(
    "The expected members must match the import's participants.",
  );
});

it("counts an event that lands after the caller stops, and only then", async () => {
  const controller = new AbortController();
  let release!: (decision: Decision) => void;
  const { service, sent } = setup({
    status: "active",
    decide: () =>
      new Promise<Decision>((resolve) => {
        release = resolve;
        controller.abort();
      }),
  });
  const pending = service.publish(
    proposal.id,
    [message(1_735_732_800, "1"), message(1_735_732_801, "2")],
    {},
    controller.signal,
  );
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  release({ delivery: "accepted" });
  const report = await pending;
  expect(report).toMatchObject({ status: "stopped", published: 1 });
  expect(report.ids).toEqual([sent[0]?.id]);

  const refusedController = new AbortController();
  let refuse!: (decision: Decision) => void;
  const refused = setup({
    status: "active",
    decide: () =>
      new Promise<Decision>((resolve) => {
        refuse = resolve;
        refusedController.abort();
      }),
  });
  const stopped = refused.service.publish(
    proposal.id,
    [message(1_735_732_800, "1")],
    {},
    refusedController.signal,
  );
  await vi.waitFor(() => expect(refuse).toBeTypeOf("function"));
  refuse({ delivery: "failed", error: "invalid: import event malformed" });
  expect(await stopped).toMatchObject({ status: "stopped", published: 0 });
  expect(refused.items).toHaveLength(0);
});

it("gives up on an attempt that never settles after a stop, dismisses it and stops listening", async () => {
  const controller = new AbortController();
  const { service, writer, sent, listeners, expiries } = setup({
    status: "active",
    decide: () =>
      new Promise<Decision>(() => {
        controller.abort();
      }),
  });
  const pending = service.publish(
    proposal.id,
    [message(1_735_732_800, "1")],
    {},
    controller.signal,
  );
  await vi.waitFor(() => expect(expiries).toHaveLength(1));
  expect(listeners.size).toBeGreaterThan(0);
  expiries[0]?.();
  expect(await pending).toMatchObject({ status: "stopped", published: 0 });
  expect(writer.dismiss).toHaveBeenCalledWith(sent[0]?.id);
  expect(listeners.size).toBe(0);
});

it("finds or opens a direct message and returns the relay's member list", async () => {
  const found = setup();
  await expect(
    found.service.ensureDirectMessage([partner], { createIfMissing: false }),
  ).resolves.toEqual({
    channelId: channel,
    created: false,
    members: [viewer, partner],
  });
  const stale = setup({ roster: () => [viewer, partner, outsider] });
  await expect(
    stale.service.ensureDirectMessage([partner], { createIfMissing: false }),
  ).rejects.toThrow("could not be confirmed");

  const created = setup({ verified: [viewer, partner, outsider] });
  const pending = created.service.ensureDirectMessage([outsider], {
    createIfMissing: true,
  });
  const review = await nextReview(created.reviews);
  expect(review.type).toBe("direct-message");
  created.reviews.approve(review.id);
  await expect(pending).resolves.toEqual({
    channelId: "d0".repeat(16),
    created: true,
    members: [viewer, outsider],
  });
});

it("checks an existing channel against the relay's member list", async () => {
  const input = {
    name: "general",
    visibility: "private" as const,
    members: [partner],
    existingChannelId: channel,
  };
  const dm = setup();
  await expect(dm.service.ensureChannel(input)).rejects.toThrow(
    "That channel is unavailable.",
  );
  const archived = setup({
    channel: { channelType: "stream", visibility: "private", archived: true },
  });
  await expect(archived.service.ensureChannel(input)).rejects.toThrow(
    "archived",
  );
  const gone = setup({
    channel: { channelType: "stream", visibility: "private" },
    roster: () => [partner],
  });
  await expect(gone.service.ensureChannel(input)).rejects.toThrow(
    "You are not a member of that channel.",
  );
  // The cached list looks right; the relay's roster has someone else too.
  const crowded = setup({
    channel: { channelType: "stream", visibility: "private" },
    roster: () => [viewer, partner, outsider],
  });
  await expect(crowded.service.ensureChannel(input)).rejects.toThrow(
    "One member of that channel is not in the source conversation.",
  );
  const ok = setup({
    channel: { channelType: "stream", visibility: "private" },
  });
  await expect(ok.service.ensureChannel(input)).resolves.toEqual({
    channelId: channel,
    created: false,
    members: [viewer, partner],
  });
});

it("creates a private channel and returns its read-back members", async () => {
  const { service, reviews, session } = setup();
  const pending = service.ensureChannel({
    name: "imported",
    visibility: "private",
    members: [partner],
  });
  const review = await nextReview(reviews);
  expect(review.type).toBe("channel");
  reviews.approve(review.id);
  await expect(pending).resolves.toEqual({
    channelId: "c0".repeat(16),
    created: true,
    members: [viewer, partner],
  });
  expect(session.memberAdditions.add).toHaveBeenCalledWith(
    "c0".repeat(16),
    partner,
  );
});

it("reads back only this import's events, oldest first", async () => {
  const { service, snapshotRead } = setup({ status: "active" });
  const mine = stamp(
    viewer,
    {
      kind: 9,
      content: "x",
      tags: [
        ["h", channel],
        ["import", proposal.id],
        ["source", "slack", "2"],
      ],
    },
    1_735_732_900,
  );
  const earlier = stamp(
    partner,
    {
      kind: 7,
      content: "+",
      tags: [
        ["h", channel],
        ["e", mine.id],
        ["import", proposal.id],
        ["source", "slack", "1"],
      ],
    },
    1_735_732_800,
  );
  const other = stamp(viewer, {
    kind: 9,
    content: "y",
    tags: [["h", channel]],
  });
  snapshotRead.mockImplementation(async (filters: readonly ReadFilter[]) => {
    const filter = filters[0];
    if (filter?.kinds?.includes(9)) return [mine, earlier, other];
    if (filter?.ids?.includes(proposal.id)) return [proposal];
    return [];
  });
  const report = await service.readBack(proposal.id);
  expect(report.events).toEqual([
    {
      id: earlier.id,
      pubkey: partner,
      kind: 7,
      source_ref: "1",
      created_at: 1_735_732_800,
    },
    {
      id: mine.id,
      pubkey: viewer,
      kind: 9,
      source_ref: "2",
      created_at: 1_735_732_900,
    },
  ]);
  expect(service.exists(channel, mine.id)).toBe(true);
});

it("predicts attachment tags every participant can reproduce from the file's bytes, and checks the upload against them", async () => {
  const { service, upload } = setup();
  const hash = "c".repeat(64);
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0,
  ]);
  const input = { sha256Hex: hash, name: "diagram.png", size: 9, head: png };
  const predicted = service.attachmentTags(input);
  expect(predicted).toEqual({
    url: `${origin}/media/${hash}.png`,
    tags: [
      [
        "imeta",
        `url ${origin}/media/${hash}.png`,
        "m image/png",
        "size 9",
        `x ${hash}`,
        "filename diagram.png",
      ],
    ],
    markdown: `![diagram.png](<${origin}/media/${hash}.png>)`,
  });
  const pdf = new TextEncoder().encode("%PDF-1.7\n");
  expect(
    service.attachmentTags({ ...input, name: "a.pdf", size: 9, head: pdf }),
  ).toMatchObject({
    url: `${origin}/media/${hash}.pdf`,
    tags: [expect.arrayContaining(["m application/pdf"])],
  });
  const text = new TextEncoder().encode("name,count\nalpha,1\n");
  expect(
    service.attachmentTags({
      ...input,
      name: "data.csv",
      size: text.length,
      head: text,
    }),
  ).toMatchObject({
    url: `${origin}/media/${hash}.bin`,
    tags: [expect.arrayContaining(["m application/octet-stream"])],
  });
  const audio = new TextEncoder().encode("ID3\u0004\u0000\u0000\u0000\u0000");
  expect(() =>
    service.attachmentTags({
      ...input,
      name: "voice.mp3",
      size: audio.length,
      head: audio,
    }),
  ).toThrow("This file type cannot be imported as an attachment.");
  expect(() => service.attachmentTags({ ...input, size: 5000 })).toThrow(
    "first 4096 bytes",
  );

  const file = new Blob([png], { type: "image/png" });
  await expect(
    service.uploadAttachment(file, "diagram.png", hash, undefined, {
      channelId: channel,
    }),
  ).resolves.toEqual(predicted);
  const csv = new Blob([text], { type: "text/csv" });
  upload.mockResolvedValueOnce({
    name: "data.csv",
    url: `${origin}/media/${hash}.bin`,
    type: "application/octet-stream",
    size: text.length,
    sha256: hash,
  });
  await expect(
    service.uploadAttachment(csv, "data.csv", hash, undefined, {
      channelId: channel,
    }),
  ).resolves.toMatchObject({ url: `${origin}/media/${hash}.bin` });
  upload.mockResolvedValueOnce({
    name: "diagram.png",
    url: `${origin}/media/${hash}.bin`,
    type: "image/png",
    size: 9,
    sha256: hash,
  });
  await expect(
    service.uploadAttachment(file, "diagram.png", hash, undefined, {
      channelId: channel,
    }),
  ).rejects.toThrow("cannot be attached");
  upload.mockResolvedValueOnce({
    name: "diagram.png",
    url: `${origin}/media/${"e".repeat(64)}.png`,
    type: "image/png",
    size: 9,
    sha256: "e".repeat(64),
  });
  await expect(
    service.uploadAttachment(file, "diagram.png", hash, undefined, {
      channelId: channel,
    }),
  ).rejects.toThrow("cannot be attached");
  const uploadsBefore = upload.mock.calls.length;
  await expect(
    service.uploadAttachment(
      new Blob([audio], { type: "audio/mpeg" }),
      "voice.mp3",
      hash,
      undefined,
      { channelId: channel },
    ),
  ).rejects.toThrow("cannot be imported as an attachment");
  expect(upload.mock.calls.length).toBe(uploadsBefore);
});

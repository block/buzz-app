import { expect } from "@playwright/test";
import { verifyEvent } from "nostr-tools";
import { createHash } from "node:crypto";

const ELIGIBLE = [9, 40002, 45001, 45003];
export const buzzV1Discovery = Object.freeze({
  version: 1,
  base_path: "/buzz/v1",
  retention_seconds: 2592000,
  max_channels: 20,
  max_intents: 100,
  max_contexts: 20,
  max_context_messages: 100,
  max_thread_summaries: 5,
  eligible_kinds: ELIGIBLE,
});
const exact = (value) => ({ status: "exact", value });
const newest = (a, b) =>
  b.created_at - a.created_at || a.id.localeCompare(b.id);

/** A narrow `/buzz/v1` read model over the fixture's signed history. It follows
 * docs/buzz-v1-read-state.md closely enough to drive the client; the relay's
 * own test suites and a real-relay pass prove the contract, not this model. */
function buzzV1({ viewer, report, rows, events }) {
  // community -> channel -> { channel, cut, threads: Map<root, through> }
  const frontiers = new Map();
  // `channel/parent` keys whose conversation membership the relay cannot decide.
  const unproved = new Set();
  const staffDeleted = new Set(); // Deletions the relay honours via `deleted_at`.
  report.readWrites = [];
  report.sidebarReads = [];
  report.sidebarHolds = [];
  const state = (community, channel) => {
    if (!frontiers.has(community)) frontiers.set(community, new Map());
    const all = frontiers.get(community);
    if (!all.has(channel))
      all.set(channel, {
        channel: null,
        cut: null,
        threads: new Map(),
      });
    return all.get(channel);
  };
  const max = (a, b) => (a === null ? b : Math.max(a, b));
  const member = (community, channel) =>
    rows(community).find((row) => row.channel_id === channel);
  function history(community, channel) {
    const all = new Map();
    for (const event of events(community, channel))
      if (event.tags.some(([k, v]) => k === "h" && v === channel))
        all.set(event.id, event);
    return all;
  }
  // NIP-10 as relay ingest and the app parse it: only a valid marked `reply`
  // makes a reply; the last valid `root`/`reply` wins; reply-only roots at it.
  function threadRef(event) {
    let root, reply;
    for (const [k, v, , marker] of event.tags) {
      if (k !== "e" || !/^[0-9a-f]{64}$/i.test(v ?? "")) continue;
      if (marker === "root") root = v.toLowerCase();
      if (marker === "reply") reply = v.toLowerCase();
    }
    return reply ? { root: root ?? reply, parent: reply } : undefined;
  }
  // Canonical root, or `undefined` for top-level; `null` marks unresolved ancestry.
  function rootOf(all, event) {
    let current = event;
    for (let depth = 0; depth < 32; depth++) {
      const ref = threadRef(current);
      if (!ref) return current === event ? undefined : current.id;
      const parent = all.get(ref.root);
      if (!parent) return null;
      current = parent;
    }
    return null;
  }
  // Author-signed kind 5/9005, or a staff deletion the relay records.
  const deletions = new WeakMap(); // One `author/id` set per history snapshot.
  function deleted(all, event) {
    if (staffDeleted.has(event.id)) return true;
    if (!deletions.has(all)) {
      const keys = new Set();
      for (const row of all.values())
        if (row.kind === 5 || row.kind === 9005)
          for (const [k, v] of row.tags)
            if (k === "e" && v) keys.add(`${row.pubkey}/${v.toLowerCase()}`);
      deletions.set(all, keys);
    }
    return deletions.get(all).has(`${event.pubkey}/${event.id}`);
  }
  // Direct-parent membership in this channel: the viewer's live eligible
  // message is the parent, or the viewer has a live reply to the same parent.
  // `null` is undecided (the relay's lookup budget ran out).
  function conversation(all, channel, parent) {
    if (unproved.has(`${channel}/${parent}`)) return null;
    const live = (row) =>
      row.pubkey === viewer &&
      ELIGIBLE.includes(row.kind) &&
      !deleted(all, row);
    const own = all.get(parent);
    return (
      (own !== undefined && live(own)) ||
      [...all.values()].some(
        (row) => live(row) && threadRef(row)?.parent === parent,
      )
    );
  }
  // Order (plan rev 3a): eligibility, then the read frontier, then relevance.
  function classify(community, channel, all, event) {
    if (
      !ELIGIBLE.includes(event.kind) ||
      event.pubkey === viewer ||
      deleted(all, event)
    )
      return { counted: false };
    const root = rootOf(all, event);
    const frontier = state(community, channel);
    const through =
      root === undefined
        ? frontier.channel
        : max(frontier.threads.get(root) ?? null, frontier.cut);
    if (through !== null && event.created_at <= through)
      return { counted: true, root, unread: false };
    const unread = { counted: true, root, unread: true };
    const tag = (name, value) =>
      event.tags.some(([k, v]) => k === name && v?.toLowerCase() === value);
    if (member(community, channel)?.channel_type === "dm")
      return { ...unread, reason: "direct" };
    if (tag("p", viewer)) return { ...unread, reason: "mention" };
    const broadcast = tag("broadcast", "1");
    const parent = threadRef(event)?.parent;
    if (!parent) return { ...unread, reason: broadcast ? "broadcast" : null };
    const joined = conversation(all, channel, parent);
    if (joined) return { ...unread, reason: "conversation" };
    // Undecided broadcasts keep known counts: the named `broadcast` fallback.
    if (broadcast) return { ...unread, reason: "broadcast" };
    if (joined === null) return { ...unread, undecided: true };
    return { counted: false }; // Proven outside the viewer's conversations.
  }
  const count = (known, uncertain) =>
    uncertain
      ? known
        ? { status: "at_least", value: known }
        : { status: "unknown" }
      : exact(known);
  function row(community, meta) {
    const channel = meta.channel_id;
    const all = history(community, channel);
    const sorted = [...all.values()].toSorted(newest);
    const latest = sorted.find((event) => ELIGIBLE.includes(event.kind));
    let unread = 0,
      attention = 0,
      uncertain = false,
      unresolved = false;
    const threads = new Map();
    for (const event of sorted) {
      const result = classify(community, channel, all, event);
      if (!result.counted || !result.unread) continue;
      if (result.root === null) unresolved = true;
      // An undecided reply stays out of every count and preview. Its group could
      // be any thread once decided, so every count in the channel is a lower bound.
      if (result.undecided) {
        uncertain = true;
        continue;
      }
      const item =
        typeof result.root === "string" &&
        (threads.get(result.root) ??
          threads
            .set(result.root, {
              root_id: result.root,
              unread: 0,
              latest_reply_id: null,
              latest_reply_at: null,
            })
            .get(result.root));
      unread++;
      if (result.reason !== null) attention++;
      if (!item) continue;
      item.unread++;
      // Newest relevant reply: the preview is chosen after the filter.
      item.latest_reply_id ??= event.id;
      item.latest_reply_at ??= event.created_at;
    }
    const items = [...threads.values()].toSorted(
      (a, b) =>
        b.latest_reply_at - a.latest_reply_at ||
        a.root_id.localeCompare(b.root_id),
    );
    return {
      channel_id: channel,
      name: meta.name,
      channel_type: meta.channel_type,
      archived: meta.archived ?? false,
      hidden: meta.hidden ?? false,
      unread: count(unread, uncertain),
      attention: count(attention, uncertain),
      latest_message_id: latest?.id ?? null,
      latest_message_at: latest?.created_at ?? null,
      latest_message_complete: true,
      threads: {
        items: items.slice(0, 5).map((item) => ({
          root_id: item.root_id,
          unread: count(item.unread, uncertain),
          latest_reply_id: item.latest_reply_id,
          latest_reply_at: item.latest_reply_at,
        })),
        complete: !unresolved && !uncertain && items.length <= 5,
      },
    };
  }
  const account = {
    retention_seconds: 2592000,
    cutoff_ms: 0,
  };
  function sidebar(community, params) {
    const all = rows(community).toSorted((a, b) =>
      a.channel_id.localeCompare(b.channel_id),
    );
    if (params.has("channel_ids")) {
      expect([...params.keys()]).toEqual(["channel_ids"]);
      const wanted = params.get("channel_ids").split(",");
      expect(wanted.length).toBeGreaterThan(0);
      expect(wanted.length).toBeLessThanOrEqual(20);
      expect(new Set(wanted).size).toBe(wanted.length);
      return {
        account,
        channels: all
          .filter((meta) => wanted.includes(meta.channel_id))
          .map((meta) => row(community, meta)),
        next_cursor: null,
      };
    }
    expect(params.get("limit")).toBe("20");
    const cursor = params.get("cursor");
    const page = all
      .filter((meta) => cursor === null || meta.channel_id > cursor)
      .slice(0, 21);
    const channels = page.slice(0, 20).map((meta) => row(community, meta));
    return {
      account,
      channels,
      next_cursor: page.length > 20 ? channels.at(-1).channel_id : null,
    };
  }
  function contexts(community, targets) {
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.length).toBeLessThanOrEqual(20);
    return {
      account,
      contexts: targets.map(({ target, message_ids }) => {
        const channel = target.channel_id;
        if (!member(community, channel)) return { status: "unavailable" };
        const all = history(community, channel);
        const frontier = state(community, channel);
        return {
          status: "available",
          through_timestamp:
            target.root_id === undefined
              ? frontier.channel
              : max(frontier.threads.get(target.root_id) ?? null, frontier.cut),
          messages: message_ids.map((message_id) => {
            const event = all.get(message_id);
            if (!event || rootOf(all, event) !== target.root_id)
              return { message_id, status: "unavailable" };
            const result = classify(community, channel, all, event);
            if (!result.counted) return { message_id, status: "not_counted" };
            if (!result.unread) return { message_id, status: "read" };
            if (result.undecided) return { message_id, status: "unknown" };
            return { message_id, status: "unread", reason: result.reason };
          }),
        };
      }),
    };
  }
  function apply(community, intent) {
    const channel =
      intent.type === "mark_through"
        ? intent.target.channel_id
        : intent.channel_id;
    if (!member(community, channel)) return { status: "blocked" };
    const all = history(community, channel);
    const anchor = all.get(intent.message_id);
    if (!anchor) return { status: "blocked" };
    if (!ELIGIBLE.includes(anchor.kind)) return { status: "invalid" };
    const frontier = state(community, channel);
    if (intent.type === "mark_channel_read") {
      frontier.channel = max(frontier.channel, anchor.created_at);
      frontier.cut = max(frontier.cut, anchor.created_at);
      return { status: "applied" };
    }
    const root = rootOf(all, anchor);
    if (root === null || root !== intent.target.root_id)
      return { status: "invalid" };
    if (root === undefined)
      frontier.channel = max(frontier.channel, anchor.created_at);
    else
      frontier.threads.set(
        root,
        max(frontier.threads.get(root) ?? null, anchor.created_at),
      );
    return { status: "applied" };
  }
  let held = false;
  const waiters = [];
  const failures = [];
  return {
    /** Hold GET reads (sidebar pages and contexts); writes still pass. */
    hold() {
      held = true;
    },
    release() {
      held = false;
      for (const release of waiters.splice(0)) release();
    },
    /** Membership of `parent` in `channel` is undecided, like an exhausted
     * relay lookup budget. Mentions, DMs and broadcasts are unaffected. */
    unprove(channel, parent) {
      unproved.add(`${channel}/${parent.toLowerCase()}`);
    },
    /** A staff deletion: the relay honours it through `deleted_at`. */
    deleteAsStaff(id) {
      staffDeleted.add(id.toLowerCase());
    },
    /** Next API response fails with this HTTP status (429/503 carry Retry-After). */
    failNext(status) {
      expect(status).toBeGreaterThanOrEqual(400);
      failures.push(status);
    },
    frontier: (community, channel) => state(community, channel),
    async fetch(community, url, init) {
      const method = init?.method ?? "GET";
      const auth = JSON.parse(
        Buffer.from(init.headers.Authorization.slice(6), "base64").toString(),
      );
      expect(verifyEvent(auth)).toBe(true);
      expect(auth.pubkey).toBe(viewer);
      expect(auth.kind).toBe(27235);
      expect(auth.tags).toContainEqual(["u", String(url)]);
      expect(auth.tags).toContainEqual(["method", method]);
      if (method === "POST")
        expect(auth.tags).toContainEqual([
          "payload",
          createHash("sha256").update(init.body).digest("hex"),
        ]);
      else {
        expect(init.body).toBeUndefined();
        expect(auth.tags.some(([name]) => name === "payload")).toBe(false);
      }
      const { pathname, searchParams } = new URL(url);
      const read = {
        community,
        method,
        pathname,
        params: Object.fromEntries(searchParams),
        at: performance.now(),
      };
      report.sidebarReads.push(read);
      if (held && method === "GET")
        await new Promise((resolve, reject) => {
          const hold = { pending: true, aborted: false };
          report.sidebarHolds.push(hold);
          const abort = () => {
            hold.pending = false;
            hold.aborted = true;
            reject(init.signal.reason);
          };
          if (init.signal?.aborted) return abort();
          init.signal?.addEventListener("abort", abort, { once: true });
          waiters.push(() => {
            hold.pending = false;
            init.signal?.removeEventListener("abort", abort);
            if (!hold.aborted) resolve();
          });
        });
      if (failures.length) {
        const status = failures.shift();
        read.status = status;
        return Response.json(
          { error: { code: "temporarily_unavailable", request_id: "fixture" } },
          {
            status,
            headers: [429, 503].includes(status) ? { "Retry-After": "1" } : {},
          },
        );
      }
      if (pathname === "/buzz/v1/me/sidebar" && method === "GET")
        return Response.json(sidebar(community, searchParams));
      expect(pathname).toBe("/buzz/v1/me/read-state");
      if (method === "GET") {
        expect([...searchParams.keys()]).toEqual(["targets"]);
        return Response.json(
          contexts(community, JSON.parse(searchParams.get("targets"))),
        );
      }
      expect(method).toBe("POST");
      const { intents, ...rest } = JSON.parse(init.body);
      expect(rest).toEqual({});
      expect(intents.length).toBeGreaterThan(0);
      expect(intents.length).toBeLessThanOrEqual(100);
      const outcomes = intents.map((intent) => apply(community, intent));
      report.readWrites.push({
        community,
        intents,
        outcomes,
        at: performance.now(),
      });
      return Response.json({ outcomes, projection_status: "not_requested" });
    },
  };
}

/** Model the relay boundaries that matter to this journey, not a replacement
 * session: AUTH, explicit channel fan-out, EOSE, CLOSED and HTTP quota reasons.
 * The production broker owns all pacing, signing, SSE and retry controls. */
export function policyRelay({
  viewer,
  relayAuthor,
  answer,
  report,
  pending,
  discovery,
  acceptPublication,
  readModel,
  latencyMs = 0,
  holdOlder = true,
}) {
  const sidebarApi = readModel && buzzV1({ viewer, report, ...readModel });
  const sockets = [];
  let presenceHeld = false;
  const presenceWaiters = [];
  report.presenceSnapshots = [];
  report.presencePublications = [];
  const requests = [];
  const rejected = [];
  report.liveRequests = requests;
  report.quotaRefusals = rejected;
  const quotas = new Map();
  // Opt-in scale profile: the relay's per-principal, per-community Redis counter.
  // REQ and EVENT share a five-second window starting on the first frame;
  // rejected frames increment it too. AUTH/CLOSE do not spend this budget.
  let wsLimit = 0;
  let eoseMs = 0;
  const wsWindows = new Map();
  report.wsAdmissions = [];
  function admitWs(socket, kind, id) {
    if (!wsLimit || !["REQ", "EVENT"].includes(kind)) return true;
    const now = performance.now();
    let window = wsWindows.get(socket.community);
    if (!window || now >= window.reset) {
      window = { count: 0, reset: now + 5000 };
      wsWindows.set(socket.community, window);
    }
    const accepted = ++window.count <= wsLimit;
    report.wsAdmissions.push({
      kind,
      id: kind === "EVENT" ? id.id : id,
      community: socket.community,
      at: now,
      accepted,
    });
    if (!accepted) {
      // Redis TTL reports remaining milliseconds rounded to the nearest second.
      const seconds = Math.round((window.reset - now) / 1000);
      const reason = `rate-limited: quota exceeded; retry in ${seconds}s`;
      const reject = () =>
        emit(
          socket,
          kind === "REQ"
            ? ["CLOSED", id, reason]
            : ["OK", id.id, false, reason],
        );
      if (eoseMs) setTimeout(reject, eoseMs);
      else queueMicrotask(reject);
    }
    return accepted;
  }
  const heldEose = new Set();
  const pendingEose = [];
  const pendingProfiles = [];
  const profileHolds = [];
  report.profileHolds = profileHolds;
  let heldAuthors = new Set();
  // Fixture targets distinguish the two explicit production globals from channels.
  const routeOf = (filter) =>
    filter["#h"]?.[0] ??
    (filter.kinds.length === 3 &&
    [0, 10100, 30177].every((kind) => filter.kinds.includes(kind))
      ? "profiles"
      : filter.kinds.includes(44100)
        ? "membership"
        : filter.kinds.includes(24200)
          ? "observer"
          : undefined);
  report.wireFrames = [];
  report.startupFrames = [];
  let emptyRoster = false;
  let heldContent = false;
  const communityOf = (url) =>
    String(url).includes("secondary") ? "secondary" : "primary";
  const fault = (error) => {
    report.unexpected.push(String(error));
    throw error;
  };
  function emit(socket, frame) {
    report.wireFrames.push(frame);
    if (wsLimit)
      report.startupFrames.push({
        socket: sockets.indexOf(socket),
        frame,
        at: performance.now(),
      });
    if (socket.readyState === 1)
      socket.onmessage?.({ data: JSON.stringify(frame) });
  }
  return {
    startupQuota(limit, setupLatencyMs = 40) {
      wsLimit = limit;
      eoseMs = setupLatencyMs;
    },
    holdPresence() {
      presenceHeld = true;
    },
    releasePresence() {
      presenceHeld = false;
      for (const release of presenceWaiters.splice(0)) release();
    },
    holdContent() {
      heldContent = true;
    },
    holdProfiles(authors) {
      heldAuthors = new Set(authors);
    },
    releaseProfiles() {
      heldAuthors.clear();
      for (const release of pendingProfiles.splice(0)) release();
    },
    holdEose(channel) {
      heldEose.add(channel);
    },
    releaseEose(channel) {
      heldEose.delete(channel);
      for (let i = pendingEose.length - 1; i >= 0; i--) {
        const item = pendingEose[i];
        if (item.routes.some((route) => heldEose.has(route))) continue;
        pendingEose.splice(i, 1);
        if (item.socket.routes.has(item.id))
          emit(item.socket, ["EOSE", item.id]);
      }
    },
    /** The `/buzz/v1` model's hold/release/unprove/failNext/frontier controls. */
    sidebarApi,
    sockets,
    requests,
    rejected,
    expectedHttpErrors: () => rejected.length > 0,
    /** The broker pauses its API lane for the advertised delay when it reads
     * the refusal, before the fixture stamps `relayed` on response finish.
     * Browser-side cooldowns need the page clock; see the retry specs. */
    brokerCooldownOver(index = 0) {
      const rejection = rejected[index];
      return (
        rejection?.relayed !== undefined &&
        performance.now() >= rejection.relayed + rejection.retryAfterMs
      );
    },
    emptyRoster() {
      emptyRoster = true;
    },
    quotaNextRoster(seconds = 1) {
      quotas.set("roster", seconds);
    },
    quotaNextHead(channel, seconds = 1) {
      quotas.set(channel, seconds);
    },
    quotaNextOlder(channel, seconds = 1) {
      quotas.set(`older:${channel}`, seconds);
    },
    async fetch(url, init) {
      try {
        if (latencyMs)
          await new Promise((resolve) => setTimeout(resolve, latencyMs));
        // Consumer cancellation of a held read is normal, not a protocol fault.
        if (sidebarApi && new URL(url).pathname.startsWith("/buzz/v1/"))
          return sidebarApi
            .fetch(communityOf(url), url, init)
            .catch((error) => {
              if (init?.signal?.aborted) throw error;
              return fault(error);
            });
        // NIP-11 is a public GET with no signed query body. The rail now reads
        // it for saved communities, including inactive ones.
        if (!init?.body) {
          expect(new URL(url).pathname).toBe("/");
          return Response.json({
            ...discovery?.(communityOf(url)),
            ...(sidebarApi && { buzz_v1: buzzV1Discovery }),
          });
        }
        expect(["/query", ...(acceptPublication ? ["/events"] : [])]).toContain(
          new URL(url).pathname,
        );
        const auth = JSON.parse(
          Buffer.from(init.headers.Authorization.slice(6), "base64").toString(),
        );
        expect(verifyEvent(auth)).toBe(true);
        expect(auth.pubkey).toBe(viewer);
        expect(auth.kind).toBe(27235);
        expect(auth.tags).toContainEqual(["u", String(url)]);
        expect(auth.tags).toContainEqual([
          "payload",
          createHash("sha256").update(init.body).digest("hex"),
        ]);
        const filters = JSON.parse(init.body);
        if (new URL(url).pathname === "/events") {
          acceptPublication(communityOf(url), filters);
          return Response.json({ accepted: true, event_id: filters.id });
        }
        if (filters.some((filter) => filter.thread_window)) {
          expect(filters).toHaveLength(1);
          const [replies] = filters;
          expect(replies.thread_window).toBe(true);
          expect(replies["#h"]).toHaveLength(1);
          expect(replies["#e"]).toHaveLength(1);
          expect(replies.depth_limit).toBe(100);
          expect(replies.include_aux).toBe(true);
          expect(replies.kinds.toSorted((a, b) => a - b)).toEqual([9, 40002]);
          report.queries.push({
            community: communityOf(url),
            filter: replies,
            at: performance.now(),
          });
          return Response.json(answer(communityOf(url), replies));
        }
        if (filters.length === 2 && filters[1].kinds?.includes(13534)) {
          // Identity archive consent: the target's profile plus the relay roster.
          expect(filters).toEqual([
            { kinds: [0], authors: [expect.any(String)], limit: 1 },
            { kinds: [13534], authors: [relayAuthor], limit: 1 },
          ]);
          for (const filter of filters)
            report.queries.push({
              community: communityOf(url),
              filter,
              at: performance.now(),
            });
          return Response.json(
            filters.flatMap((filter) => answer(communityOf(url), filter)),
          );
        }
        if (filters.length === 2 && filters[0].kinds?.includes(39000)) {
          // Exact channel authority lookup, distinct from sidebar preferences.
          const ids = filters[0]["#d"];
          expect(Array.isArray(ids)).toBe(true);
          expect(ids.length).toBeGreaterThan(0);
          expect(ids.length).toBeLessThanOrEqual(128);
          expect(new Set(ids).size).toBe(ids.length);
          expect(filters).toEqual([
            {
              kinds: [39000],
              authors: [relayAuthor],
              "#d": ids,
              limit: ids.length + 1,
            },
            {
              kinds: [39002],
              authors: [relayAuthor],
              "#d": ids,
              "#p": [viewer],
              limit: ids.length + 1,
            },
          ]);
          const community = communityOf(url);
          for (const filter of filters)
            report.queries.push({ community, filter, at: performance.now() });
          return Response.json(
            filters.flatMap((filter) =>
              emptyRoster && filter.kinds.includes(39002)
                ? []
                : answer(community, filter),
            ),
          );
        }
        if (
          filters.length <= 128 &&
          filters.every(
            (filter) =>
              filter.limit === 1 &&
              filter["#h"]?.length === 1 &&
              [9, 40002, 40008, 45001, 45003].every((kind) =>
                filter.kinds?.includes(kind),
              ),
          )
        ) {
          for (const filter of filters)
            report.queries.push({
              community: communityOf(url),
              filter,
              at: performance.now(),
            });
          return Response.json(
            filters.flatMap((filter) => answer(communityOf(url), filter)),
          );
        }
        if (
          filters.length === 3 &&
          filters.every(
            (filter) =>
              filter.kinds?.length === 1 &&
              [39000, 39001, 39002].includes(filter.kinds[0]),
          )
        ) {
          expect(filters.map((filter) => filter.kinds[0])).toEqual([
            39000, 39001, 39002,
          ]);
          expect(new Set(filters.map((filter) => filter["#d"]?.[0])).size).toBe(
            1,
          );
          for (const filter of filters) {
            expect(filter.limit).toBe(1);
            report.queries.push({
              community: communityOf(url),
              filter,
              at: performance.now(),
            });
          }
          return Response.json(
            filters.flatMap((filter) => answer(communityOf(url), filter)),
          );
        }
        if (filters.length === 2 && "#buzz-channel" in filters[0]) {
          // A channel's project-home read: projects and repositories, one channel.
          const channel = filters[0]["#buzz-channel"];
          expect(channel).toEqual([expect.any(String)]);
          expect(filters).toEqual(
            [30621, 30617].map((kind) => ({
              kinds: [kind],
              "#buzz-channel": channel,
              limit: 100,
            })),
          );
          const community = communityOf(url);
          for (const filter of filters)
            report.queries.push({ community, filter, at: performance.now() });
          return Response.json(
            filters.flatMap((filter) => answer(community, filter)),
          );
        }
        if (filters.length === 2 && filters[1].kinds?.includes(40003)) {
          // An Activity preview read: the listed newest replies and their edits.
          const ids = filters[0].ids;
          expect(ids?.length).toBeGreaterThan(0);
          expect(ids.length).toBeLessThanOrEqual(5);
          expect(filters).toEqual([
            { ids, limit: 5 },
            { kinds: [40003], "#e": ids, limit: 500 },
          ]);
          const community = communityOf(url);
          for (const filter of filters)
            report.queries.push({ community, filter, at: performance.now() });
          return Response.json(
            filters.flatMap((filter) => answer(community, filter)),
          );
        }
        if (filters.length !== 1) {
          // Sidebar preferences read only these four exact own-author coordinates.
          expect(filters).toHaveLength(4);
          expect(filters.map((filter) => filter["#d"]?.[0]).sort()).toEqual([
            "channel-mutes",
            "channel-sections",
            "channel-sort",
            "channel-stars",
          ]);
          for (const filter of filters) {
            expect(filter.kinds).toEqual([30078]);
            expect(filter.authors).toEqual([viewer]);
            expect(filter.limit).toBe(1);
            report.queries.push({
              community: communityOf(url),
              filter,
              at: performance.now(),
            });
          }
          return Response.json(
            filters.flatMap((filter) => answer(communityOf(url), filter)),
          );
        }
        const filter = filters[0],
          community = communityOf(url);
        report.queries.push({ community, filter, at: performance.now() });
        if (filter.kinds?.includes(20001)) {
          expect(Object.keys(filter).sort()).toEqual([
            "authors",
            "kinds",
            "limit",
          ]);
          expect(filter.authors.length).toBeGreaterThan(0);
          expect(filter.authors.length).toBeLessThanOrEqual(256);
          expect(filter.limit).toBe(filter.authors.length);
          const snapshot = {
            community,
            filter,
            pending: presenceHeld,
            aborted: false,
          };
          report.presenceSnapshots.push(snapshot);
          // Return the pending fetch, like the profile/content holds below.
          // Awaiting it inside the fixture assertion catch misclassifies normal
          // consumer cancellation as an unexpected protocol assertion failure.
          if (presenceHeld)
            return new Promise((resolve, reject) => {
              const abort = () => {
                snapshot.pending = false;
                snapshot.aborted = true;
                reject(init.signal.reason);
              };
              if (init.signal.aborted) return abort();
              presenceWaiters.push(() => {
                init.signal.removeEventListener("abort", abort);
                snapshot.pending = false;
                if (!snapshot.aborted)
                  resolve(Response.json(answer(community, filter)));
              });
              init.signal.addEventListener("abort", abort, { once: true });
            });
          return Response.json(answer(community, filter));
        }
        if (heldContent && filter.kinds?.includes(9))
          return new Promise((_resolve, reject) => {
            if (init.signal.aborted) reject(init.signal.reason);
            else
              init.signal.addEventListener(
                "abort",
                () => reject(init.signal.reason),
                { once: true },
              );
          });
        const channel = filter["#h"]?.[0];
        // Head catch-up is an exact top-level channel window, not a batched
        // sidebar preview that happens to contain that channel.
        const quota = filter.kinds?.includes(39002)
          ? "roster"
          : filter.kinds?.includes(9)
            ? filter.until === undefined
              ? filter["#h"]?.length === 1 && filter.top_level === true
                ? channel
                : undefined
              : `older:${channel}`
            : undefined;
        if (quotas.has(quota)) {
          const seconds = quotas.get(quota);
          quotas.delete(quota);
          rejected.push({
            channel,
            retryAfterMs: (seconds + 1) * 1000,
          });
          return Response.json(
            { error: `rate-limited: quota exceeded; retry in ${seconds}s` },
            { status: 429 },
          );
        }
        const result =
          emptyRoster && filter.kinds?.includes(39002)
            ? []
            : answer(community, filter);
        if (
          filter.kinds?.includes(0) &&
          filter.authors?.some((id) => heldAuthors.has(id))
        )
          return new Promise((resolve, reject) => {
            const held = { pending: true, aborted: false };
            profileHolds.push(held);
            const abort = () => {
              held.pending = false;
              held.aborted = true;
              reject(init.signal.reason);
            };
            init.signal.addEventListener("abort", abort, { once: true });
            pendingProfiles.push(() => {
              held.pending = false;
              init.signal.removeEventListener("abort", abort);
              resolve(Response.json(result));
            });
          });
        if (filter.until !== undefined && holdOlder)
          return new Promise((resolve, reject) => {
            const abort = () => reject(init.signal.reason);
            init.signal.addEventListener("abort", abort, { once: true });
            pending.push({
              community,
              channel,
              filter,
              events: result.filter((event) => event.kind === 9),
              release() {
                init.signal.removeEventListener("abort", abort);
                resolve(Response.json(result));
              },
            });
          });
        return Response.json(result);
      } catch (error) {
        return fault(error);
      }
    },
    socket(url) {
      const socket = {
        community: communityOf(url),
        readyState: 1,
        authenticated: false,
        routes: new Map(),
        send(text) {
          try {
            const [kind, id, ...filters] = JSON.parse(text);
            if (kind === "AUTH") {
              expect(verifyEvent(id)).toBe(true);
              expect(id.pubkey).toBe(viewer);
              expect(id.tags).toContainEqual(["challenge", "policy-fixture"]);
              this.authenticated = true;
              queueMicrotask(() => emit(this, ["OK", id.id, true]));
              return;
            }
            if (kind === "CLOSE") {
              this.routes.delete(id);
              return;
            }
            if (kind === "EVENT" && !admitWs(this, kind, id)) return;
            if (kind === "EVENT" && id.kind === 20001) {
              expect(this.authenticated).toBe(true);
              expect(verifyEvent(id)).toBe(true);
              expect(id.pubkey).toBe(viewer);
              expect(id.kind).toBe(20001);
              expect(["online", "away", "offline"]).toContain(id.content);
              expect(id.tags).toEqual([]);
              report.presencePublications.push({
                community: this.community,
                event: id,
                at: performance.now(),
              });
              queueMicrotask(() => {
                emit(this, ["OK", id.id, true]);
                for (const peer of sockets) {
                  if (peer.community !== this.community) continue;
                  for (const [wire, filters] of peer.routes)
                    if (
                      filters.some(
                        (filter) =>
                          filter.kinds.includes(20001) &&
                          filter.authors?.includes(id.pubkey),
                      )
                    )
                      emit(peer, ["EVENT", wire, id]);
                }
              });
              return;
            }
            if (kind === "EVENT" && acceptPublication) {
              expect(this.authenticated).toBe(true);
              setTimeout(() => {
                try {
                  const accepted = acceptPublication(this.community, id);
                  // A fixture may hold the OK while relay side effects proceed.
                  if (typeof accepted?.then === "function")
                    accepted.then(
                      () => emit(this, ["OK", id.id, true, ""]),
                      fault,
                    );
                  else emit(this, ["OK", id.id, true, ""]);
                } catch (error) {
                  fault(error);
                }
              }, latencyMs);
              return;
            }
            expect(
              kind,
              kind === "EVENT"
                ? `Unexpected publication kind ${id?.kind}`
                : `Unexpected relay frame ${kind}`,
            ).toBe("REQ");
            expect(this.authenticated).toBe(true);
            expect(filters.length).toBeGreaterThan(0);
            expect(filters.length).toBeLessThanOrEqual(10);
            const routes = filters.flatMap(
              (filter) => filter["#h"] ?? [routeOf(filter)],
            );
            requests.push({
              socket: sockets.indexOf(this),
              community: this.community,
              id,
              filters,
              routes,
              at: performance.now(),
            });
            if (!admitWs(this, kind, id)) return;
            for (const filter of filters) {
              const channel = filter["#h"]?.[0];
              // Initial replay stays per channel; zero replay may consolidate the wire.
              if (
                filter.kinds.includes(9) &&
                (!channel ||
                  filter["#h"].length > 10 ||
                  (filter.limit !== 0 && filter["#h"].length !== 1))
              ) {
                queueMicrotask(() =>
                  emit(this, [
                    "CLOSED",
                    id,
                    "restricted: channel filter required",
                  ]),
                );
                return;
              }
              if (filter.kinds.includes(44100))
                expect(filter["#p"]).toEqual([viewer]);
              if (filter.kinds.includes(24200)) {
                expect(filter["#p"]).toEqual([viewer]);
                expect(filter["#h"]).toBeUndefined();
                expect(filter.limit).toBeUndefined();
                expect(filter.since).toBeGreaterThanOrEqual(
                  Math.floor(Date.now() / 1000) - 1,
                );
              }
            }
            this.routes.set(id, filters);
            if (routes.some((route) => heldEose.has(route)))
              pendingEose.push({ socket: this, id, routes });
            else if (eoseMs) setTimeout(() => emit(this, ["EOSE", id]), eoseMs);
            else queueMicrotask(() => emit(this, ["EOSE", id]));
          } catch (error) {
            fault(error);
          }
        },
        close() {
          this.readyState = 3;
          this.routes.clear();
          this.onclose?.();
        },
      };
      sockets.push(socket);
      queueMicrotask(() => emit(socket, ["AUTH", "policy-fixture"]));
      return socket;
    },
    hasRoute(community, channel) {
      return sockets.some(
        (s) =>
          s.readyState === 1 &&
          s.community === community &&
          [...s.routes.values()].some((filters) =>
            filters.some((filter) =>
              (filter["#h"] ?? [routeOf(filter)]).includes(channel),
            ),
          ),
      );
    },
    presence(community, event) {
      let deliveries = 0;
      for (const socket of sockets) {
        if (socket.readyState !== 1 || socket.community !== community) continue;
        for (const [id, filters] of socket.routes) {
          if (
            !filters.some(
              (filter) =>
                filter.kinds.includes(20001) &&
                filter.authors?.includes(event.pubkey),
            )
          )
            continue;
          emit(socket, ["EVENT", id, event]);
          deliveries++;
        }
      }
      expect(
        deliveries,
        "presence must traverse the production demand-scoped REQ",
      ).toBeGreaterThan(0);
    },
    observer(community, event) {
      let deliveries = 0;
      for (const socket of sockets) {
        if (socket.readyState !== 1 || socket.community !== community) continue;
        for (const [id, filters] of socket.routes) {
          if (
            !filters.some(
              (filter) =>
                filter.kinds.includes(24200) && filter["#p"]?.includes(viewer),
            )
          )
            continue;
          emit(socket, ["EVENT", id, event]);
          deliveries++;
        }
      }
      expect(
        deliveries,
        "observer must traverse the production owner-only route",
      ).toBeGreaterThan(0);
    },
    publish(community, event) {
      let deliveries = 0;
      // Relay-authored group state names its channel with d, not h.
      const destinationTag =
        [39000, 39002].includes(event.kind) &&
        !event.tags.some(([k]) => k === "h")
          ? "d"
          : "h";
      for (const socket of sockets) {
        if (socket.readyState !== 1 || socket.community !== community) continue;
        for (const [id, filters] of socket.routes) {
          if (
            !filters.some(
              (filter) =>
                filter.kinds.includes(event.kind) &&
                filter["#h"]?.some((h) =>
                  event.tags.some(([k, v]) => k === destinationTag && h === v),
                ),
            )
          )
            continue;
          emit(socket, ["EVENT", id, event]);
          deliveries++;
        }
      }
      expect(
        deliveries,
        "event must traverse an explicit production channel REQ",
      ).toBeGreaterThan(0);
    },
    failRoute(
      community,
      channel,
      reason = "temporary: fixture stream interrupted",
    ) {
      let failures = 0;
      for (const socket of sockets) {
        if (socket.readyState !== 1 || socket.community !== community) continue;
        for (const [id, filters] of [...socket.routes]) {
          if (
            !filters.some((filter) =>
              (filter["#h"] ?? [routeOf(filter)]).includes(channel),
            )
          )
            continue;
          socket.routes.delete(id);
          emit(socket, ["CLOSED", id, reason]);
          failures++;
        }
      }
      expect(failures).toBeGreaterThan(0);
    },
    disconnect(community) {
      for (const socket of sockets)
        if (socket.community === community && socket.readyState === 1)
          socket.close();
    },
  };
}

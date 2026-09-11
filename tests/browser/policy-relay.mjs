import { expect } from "@playwright/test";
import { verifyEvent } from "nostr-tools";
import { createHash } from "node:crypto";

/** Model the relay boundaries that matter to this journey, not a replacement
 * session: AUTH, explicit channel fan-out, EOSE, CLOSED and HTTP quota reasons.
 * The production broker owns all pacing, signing, SSE and retry controls. */
export function policyRelay({
  viewer,
  answer,
  report,
  pending,
  discovery,
  acceptPublication,
}) {
  const sockets = [];
  const requests = [];
  const rejected = [];
  report.liveRequests = requests;
  report.quotaRefusals = rejected;
  const quotas = new Map();
  const heldEose = new Set();
  const pendingEose = [];
  const pendingProfiles = [];
  const profileHolds = [];
  report.profileHolds = profileHolds;
  let heldAuthors = new Set();
  // Fixture targets distinguish the two explicit production globals from channels.
  const routeOf = (filter) =>
    filter["#h"]?.[0] ??
    (filter.kinds.length === 1 && filter.kinds[0] === 0
      ? "profiles"
      : filter.kinds.includes(44100)
        ? "membership"
        : undefined);
  report.wireFrames = [];
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
    if (socket.readyState === 1)
      socket.onmessage?.({ data: JSON.stringify(frame) });
  }
  return {
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
        if (pendingEose[i].channel !== channel) continue;
        const [item] = pendingEose.splice(i, 1);
        emit(item.socket, ["EOSE", item.id]);
      }
    },
    sockets,
    requests,
    rejected,
    expectedHttpErrors: () => rejected.length > 0,
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
        if (!init?.body && discovery)
          return Response.json(discovery(communityOf(url)));
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
        if (filters.length !== 1) {
          // The read-only sidebar projection reads the two exact coordinates.
          expect(filters).toHaveLength(2);
          expect(filters.map((filter) => filter["#d"]?.[0]).sort()).toEqual([
            "channel-sections",
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
          return Response.json([]);
        }
        const filter = filters[0],
          community = communityOf(url);
        report.queries.push({ community, filter, at: performance.now() });
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
        const quota = filter.kinds?.includes(39002)
          ? "roster"
          : filter.kinds?.includes(9)
            ? filter.until === undefined
              ? channel
              : `older:${channel}`
            : undefined;
        if (quotas.has(quota)) {
          const seconds = quotas.get(quota);
          quotas.delete(quota);
          rejected.push({
            channel,
            until: performance.now() + (seconds + 1) * 1000,
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
        if (filter.until !== undefined)
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
            const [kind, id, filter] = JSON.parse(text);
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
            expect(kind).toBe("REQ");
            expect(this.authenticated).toBe(true);
            requests.push({
              socket: sockets.indexOf(this),
              community: this.community,
              id,
              filter,
              route: routeOf(filter),
              at: performance.now(),
            });
            const channel = filter["#h"]?.[0];
            // A broad channel REQ cannot substitute for explicit #h fan-out.
            if (
              filter.kinds.includes(9) &&
              (!channel || filter["#h"].length !== 1)
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
            this.routes.set(id, filter);
            const route = routeOf(filter);
            if (heldEose.has(route))
              pendingEose.push({ socket: this, id, channel: route });
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
          [...s.routes.values()].some((f) => routeOf(f) === channel),
      );
    },
    publish(community, event) {
      let deliveries = 0;
      for (const socket of sockets) {
        if (socket.readyState !== 1 || socket.community !== community) continue;
        for (const [id, filter] of socket.routes) {
          if (
            !filter.kinds.includes(event.kind) ||
            !filter["#h"]?.some((h) =>
              event.tags.some(([k, v]) => k === "h" && h === v),
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
        for (const [id, filter] of [...socket.routes]) {
          if (routeOf(filter) !== channel) continue;
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

import type { RelaySession } from "../relay/session";
import type { RelayData } from "../relay/service";
import type { ReadFilter, RelayEvent } from "../relay/events";
import { eventDto, hasEventProof } from "../relay/events";
import { attestedOwner } from "../agents/owner-attestation";
import { addChannelMember } from "../channel-members/members";
import { readView, writeView } from "../../shared/view-state";
import { splitPartition } from "../relay/partition";
import type { MoveAgentHost } from "./native";
import { planMove, movedTemplate } from "./plan";
import { threadReference } from "../relay/thread-reference";
import { LIVE_RESUME_LAG } from "../relay/live";
import type { EventData } from "../relay/events";
import {
  MOVE_TOPIC,
  controlTemplate,
  moveControl,
  moveState,
  movedSource,
  validateMoveChannels,
  type MoveControl,
  type MoveRequest,
  type MoveState,
  type ControlEvent,
} from "./protocol";

const now = () => Math.floor(Date.now() / 1000);
const terminal = new Set(["complete", "declined", "cancelled", "expired"]);
type Receipt = { id: string; signed?: RelayEvent; accepted?: true };
type Journal = {
  worker: string;
  controls: RelayEvent[];
  receipts: Record<string, Receipt>;
  cursor: number;
  ancestry?: Record<string, Record<string, string>>;
};
export type MoveSnapshot = Readonly<{
  moves: readonly MoveState[];
  error?: string | undefined;
  loading: boolean;
}>;
export type MoveStorage = {
  read(): Journal | undefined;
  write(value: Journal): void;
};
export function moveStorage(scope: string): MoveStorage {
  return {
    read: () => readView<Journal | undefined>(scope, "dm-moves", undefined),
    write: (value) => {
      if (!writeView(scope, "dm-moves", value))
        throw new Error(
          "The move could not be saved on this device. Free some storage and retry.",
        );
    },
  };
}

/** One community/viewer owner; protocol work continues when the DM is not selected. */
export function createDmMoves(
  session: RelaySession,
  agentHost?: MoveAgentHost,
  storage = moveStorage(session.scope),
) {
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  const controls = new Map<string, ControlEvent>();
  const presence = new Map<string, () => void>();
  let journal = storage.read() ?? {
    worker: crypto.randomUUID(),
    controls: [],
    receipts: {},
    cursor: 0,
  };
  let snapshot: MoveSnapshot = { moves: [], loading: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false,
    queued = false,
    hydrated = false;
  let retryAt = 0,
    failures = 0;
  let hydration: Promise<void> | undefined;
  let connectionEpoch = 0;
  const sourceEpochs = new Map<string, number>();
  const worker = journal.worker;
  const active = () => !lifetime.signal.aborted;
  const channel = (id: string) =>
    session.channels.get?.(id) ??
    session.channels.list().channels.find((c) => c.id === id);
  const receive = (events: readonly RelayEvent[]) => {
    for (const event of events) {
      const control = moveControl(event);
      if (control && channel(control.dm)?.channelType === "dm") {
        controls.set(event.id, control);
        journal.cursor = Math.max(journal.cursor, event.created_at);
      }
    }
  };
  // Restored events still need signature checks; saved prose never grants approval.
  try {
    for (const event of journal.controls.map(eventDto)) {
      const record = moveControl(event);
      if (record) controls.set(event.id, record);
    }
  } catch {
    journal = { worker, controls: [], receipts: journal.receipts, cursor: 0 };
  }
  function save() {
    const events = [...controls.values()].map((c) => c.event as RelayEvent);
    if (
      events.length > 5000 ||
      Object.keys(journal.receipts).length > 10000 ||
      JSON.stringify({
        events,
        receipts: journal.receipts,
        ancestry: journal.ancestry,
      }).length >
        8 * 1024 * 1024
    )
      throw new Error(
        "This device’s conversion history is full. Finish existing moves before starting another.",
      );
    journal.controls = events;
    storage.write(journal);
  }
  function publish(error?: string) {
    if (!active()) return;
    const moves = [...controls.values()].flatMap((r) =>
      r.control.type === "request" && channel(r.dm)?.channelType === "dm"
        ? [
            moveState(
              r as ControlEvent & { control: MoveRequest },
              [...controls.values()],
              now(),
            ),
          ]
        : [],
    );
    snapshot = { moves, loading: !hydrated, ...(error ? { error } : {}) };
    const needed = new Set(
      moves.filter((m) => !terminal.has(m.status)).flatMap((m) => m.approvers),
    );
    for (const [key, stop] of presence)
      if (!needed.has(key)) {
        stop();
        presence.delete(key);
      }
    for (const key of needed)
      if (!presence.has(key))
        presence.set(
          key,
          session.presence.subscribe(key, () => {
            publish();
            schedule();
          }),
        );
    for (const listener of listeners) listener();
  }
  async function readAll(filter: ReadFilter, maximum = 5000) {
    const events = new Map<string, RelayEvent>();
    for (let page = 1; page <= 25; page++) {
      lifetime.signal.throwIfAborted();
      const batch = await session.readRemote(
        [{ ...filter, limit: 200, page }],
        { signal: lifetime.signal, priority: "background" },
      );
      for (const e of batch) events.set(e.id, e);
      if (events.size > maximum)
        throw new Error(
          "This conversation is too large to convert safely yet.",
        );
      if (batch.length < 200) return [...events.values()];
      if (page === 25)
        throw new Error(
          "The complete conversation could not be loaded. Nothing has been copied.",
        );
    }
    return [...events.values()];
  }
  async function sync() {
    if (!active() || session.channels.list().status !== "ready") return;
    const dms = session.channels
      .list()
      .channels.filter(
        (c) => c.channelType === "dm" && !c.cached && !c.archived,
      )
      .map((c) => c.id);
    if (dms.length) {
      const events = await readAll({
        kinds: [9],
        "#h": dms,
        "#t": [MOVE_TOPIC],
        since: Math.max(0, journal.cursor - LIVE_RESUME_LAG),
        limit: 200,
      });
      receive(events);
      save();
    }
    hydrated = true;
    publish();
  }
  function hydrate() {
    if (hydration) return hydration;
    hydration = new Promise<void>((resolve) =>
      setTimeout(resolve, 250 + Math.random() * 750),
    )
      .then(() => (active() ? sync() : undefined))
      .catch((error) => {
        publish(String(error));
        throw error;
      })
      .finally(() => {
        hydration = undefined;
      });
    return hydration;
  }
  function current(request: string) {
    return snapshot.moves.find((m) => m.request.event.id === request);
  }
  async function fresh(move: string) {
    const state = current(move);
    if (!state) throw new Error("The conversion request is unavailable.");
    const events = await readAll({
      kinds: [9],
      "#h": [state.request.dm],
      "#t": [MOVE_TOPIC],
      "#d": [state.request.control.move],
      consistency: "strong",
      limit: 200,
    });
    receive(events);
    save();
    publish();
    const next = current(move);
    if (!next) throw new Error("The conversion request is unavailable.");
    return next;
  }
  async function verifiedOwner(author: string) {
    const profile = session.profiles.event?.(author);
    return profile && hasEventProof(profile)
      ? attestedOwner(profile)
      : undefined;
  }
  async function validate(state: MoveState, requireWrite = false) {
    await session.channels.resolve?.([state.request.control.target], {
      consistency: "strong",
      signal: lifetime.signal,
    });
    const req = state.request.control;
    validateMoveChannels(
      channel(state.request.dm),
      channel(req.target),
      req.authors.map((p) => p[0]),
      requireWrite,
    );
    await session.profiles.ensure(
      req.authors.map(([author]) => author),
      "foreground",
    );
    for (const [author, owner] of req.authors)
      if (author !== owner && (await verifiedOwner(author)) !== owner)
        throw new Error(
          "An agent’s owner could not be verified. Refresh the conversation and retry.",
        );
  }
  async function source(state: MoveState) {
    const events = await readAll({
      kinds: [9, 40002, 40008, 40003, 5, 9005],
      "#h": [state.request.dm],
      include_aux: true,
      consistency: "strong",
      limit: 200,
    });
    journal.ancestry ??= {};
    journal.ancestry[state.request.dm] ??= {};
    const graph = journal.ancestry[state.request.dm] ?? {};
    for (const event of events) {
      const parent = threadReference(event)?.parentId;
      if (parent && [9, 40002].includes(event.kind)) graph[event.id] = parent;
    }
    save();
    return planMove(
      state.request.dm,
      session.relayAuthor ?? "",
      events,
      state.request.control,
      session.profiles.owner,
      state.through,
      graph,
    );
  }
  async function delivery(id: string, destination: string) {
    // The existing waiter reuses failed sends and verifies a receipt absent from the journal.
    await session.directMessages.delivered(
      id,
      destination,
      AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]),
    );
  }
  function sameTemplate(
    event: EventData,
    template: { kind: number; tags: string[][]; content: string },
  ) {
    return (
      event.kind === template.kind &&
      event.content === template.content &&
      JSON.stringify(
        event.tags.filter(
          ([name]) => name !== "client-id" && name !== "ms" && name !== "auth",
        ),
      ) === JSON.stringify(template.tags)
    );
  }
  async function confirmed(id: string, destination: string) {
    const events = await session.readRemote(
      [
        {
          kinds: [9],
          ids: [id],
          "#h": [destination],
          consistency: "strong",
          limit: 1,
        },
      ],
      { signal: lifetime.signal },
    );
    return events.some((e) => e.id === id);
  }
  async function send(
    template: { kind: number; tags: string[][]; content: string },
    key: string,
    guard: () => boolean = active,
  ) {
    const outbox = session.outbox;
    if (!outbox || !active())
      throw new Error("Reconnect to continue this conversion.");
    await outbox.ready();
    const destination = template.tags.find((t) => t[0] === "h")?.[1] ?? "";
    let receipt = journal.receipts[key];
    const saved = await outbox.recovery(`dm-move:${key}`);
    if (
      saved &&
      (!sameTemplate(saved.event, template) ||
        now() - saved.event.created_at > 15 * 60)
    ) {
      // Never replace an uncertain operation while its old bytes can still land.
      if (await confirmed(saved.event.id, destination)) {
        receipt = { id: saved.event.id, accepted: true };
        journal.receipts[key] = receipt;
        save();
        await outbox.acknowledge(saved.event.id);
        return receipt.id;
      }
      if (saved.delivery === "failed") await outbox.dismiss(saved.event.id);
      else {
        let arrived = false;
        await outbox.acknowledge(saved.event.id, async () => {
          arrived = await confirmed(saved.event.id, destination);
          return arrived ? "recorded" : undefined;
        });
        if (arrived) {
          journal.receipts[key] = { id: saved.event.id, accepted: true };
          save();
          return saved.event.id;
        }
      }
      delete journal.receipts[key];
      save();
      receipt = undefined;
    }
    if (receipt && !receipt.accepted && !saved) {
      if (await confirmed(receipt.id, destination)) {
        receipt.accepted = true;
        save();
      } else {
        // A retirement completed before the feature journal could checkpoint it.
        delete journal.receipts[key];
        save();
        receipt = undefined;
      }
    }
    if (!receipt) {
      const retained = await outbox.recovery(`dm-move:${key}`);
      if (guard && !guard())
        throw new Error("The DM changed. Checking its latest messages…");
      const id =
        retained?.event.id ??
        outbox.send(template, { key: `dm-move:${key}`, value: "1" }, guard);
      receipt = { id };
      journal.receipts[key] = receipt;
      save();
    }
    if (!receipt.accepted) {
      const pending = outbox
        .snapshot()
        .find((item) => item.event.id === receipt?.id);
      if (guard && pending && ["failed", "unknown"].includes(pending.delivery))
        outbox.retry(receipt.id, guard);
      await delivery(receipt.id, destination);
      receipt.accepted = true;
      save();
    }
    await outbox.acknowledge(receipt.id);
    return receipt.id;
  }
  async function control(
    dm: string,
    value: MoveControl,
    suffix: string = value.type,
    requestId?: string,
  ) {
    const bound =
      value.type === "request" ? value : { ...value, request: requestId };
    if (bound.type !== "request" && !bound.request)
      throw new Error("The conversion request is unavailable.");
    const id = await send(
      controlTemplate(dm, bound as MoveControl),
      `${requestId ?? value.move}:${session.viewer}:${suffix}`,
    );
    const events = await session.readRemote(
      [{ kinds: [9], ids: [id], "#h": [dm], limit: 1, consistency: "strong" }],
      { signal: lifetime.signal },
    );
    if (!events.some((e) => e.id === id))
      throw new Error(
        "The conversion response has not been confirmed. It will retry after reconnecting.",
      );
    receive(events);
    save();
    publish();
    return id;
  }
  function owns(state: MoveState) {
    return state.workers.get(session.viewer ?? "") === worker;
  }
  function initiates(state: MoveState) {
    return (
      state.request.event.pubkey === session.viewer &&
      state.request.control.worker === worker
    );
  }
  async function locked<T>(
    move: string,
    run: () => Promise<T>,
  ): Promise<T | undefined> {
    if (typeof navigator === "undefined" || !navigator.locks)
      throw new Error(
        "This app cannot coordinate a conversion across windows.",
      );
    return navigator.locks.request(
      `buzz-dm-move:${session.scope}:${move}`,
      { ifAvailable: true },
      async (lock) => (lock ? run() : undefined),
    );
  }
  async function agentSend(
    state: MoveState,
    author: string,
    template: { kind: number; tags: string[][]; content: string },
    key: string,
    guard: () => boolean,
  ) {
    const origin = splitPartition(session.scope)?.communityOrigin;
    if (!agentHost || !origin)
      throw new Error("This device cannot publish its local agent’s messages.");
    let receipt = journal.receipts[key];
    if (receipt?.accepted) return receipt.id;
    if (!receipt?.signed) {
      const signed = await agentHost.prepare(author, origin, template);
      receipt = { id: signed.id, signed };
      journal.receipts[key] = receipt;
      save();
    }
    lifetime.signal.throwIfAborted();
    if (!receipt.signed)
      throw new Error("The saved agent message is unavailable.");
    if (
      !sameTemplate(receipt.signed, template) ||
      now() - receipt.signed.created_at > 14 * 60
    ) {
      const exists = await session.readRemote(
        [
          {
            kinds: [9],
            ids: [receipt.id],
            "#h": [state.request.control.target],
            consistency: "strong",
            limit: 1,
          },
        ],
        { signal: lifetime.signal },
      );
      if (exists.some((e) => e.id === receipt?.id)) {
        receipt.accepted = true;
        delete receipt.signed;
        save();
        return receipt.id;
      }
      if (now() <= receipt.signed.created_at + 15 * 60)
        throw new Error(
          "An earlier agent copy is awaiting delivery confirmation. Retry after its delivery window closes.",
        );
      const signed = await agentHost.prepare(author, origin, template);
      receipt = { id: signed.id, signed };
      journal.receipts[key] = receipt;
      save();
    }
    const verified = eventDto(receipt.signed);
    if (
      verified.pubkey !== author ||
      movedSource(verified)?.move !== state.request.control.move
    )
      throw new Error(
        "The saved agent message does not match this conversion.",
      );
    if (!guard())
      throw new Error("The DM changed. Checking its latest messages…");
    await agentHost.publish(author, origin, verified);
    lifetime.signal.throwIfAborted();
    receipt.accepted = true;
    delete receipt.signed;
    save();
    return receipt.id;
  }
  async function advance(initial: MoveState) {
    if (!owns(initial) && !initiates(initial)) return;
    if (initial.status === "pending") return;
    const move = initial.request.control.move;
    const requestId = initial.request.event.id;
    const emit = (value: MoveControl, suffix?: string) =>
      control(initial.request.dm, value, suffix, requestId);
    await locked(requestId, async () => {
      // Adopt the other window's durable receipts before allocating any send.
      const shared = storage.read();
      if (shared)
        journal.receipts = { ...journal.receipts, ...shared.receipts };
      let state = await fresh(requestId);
      if (terminal.has(state.status)) return;
      const req = state.request.control;
      await validate(state);
      if (state.status === "pending") return;
      if (!owns(state) && !initiates(state)) return;
      if (state.status === "approved") {
        // Presence is a hint; only a ready response from the app that approved can unlock posting.
        const everyoneOnline = state.approvers.every(
          (p) =>
            session.presence.status(p) === "online" || p === session.viewer,
        );
        if (
          initiates(state) &&
          everyoneOnline &&
          (!state.probe || now() > state.probe.event.created_at + 30)
        ) {
          await source(state); // Fail before adding anyone if the DM cannot be copied in full.
          const nonce = crypto.randomUUID();
          await emit({ type: "probe", move, nonce }, `probe:${nonce}`);
          state = current(requestId) ?? state;
        }
        const probe = state.probe;
        if (
          owns(state) &&
          probe?.control.type === "probe" &&
          probe.control.nonce &&
          now() <= probe.event.created_at + 15 &&
          !state.ready.includes(session.viewer ?? "")
        ) {
          // Verify local custody for every agent this owner's approval covers.
          const local = session.agentChoices?.snapshot().identities ?? [];
          if (
            req.authors.some(
              ([a, o]) =>
                o === session.viewer &&
                a !== o &&
                (!agentHost ||
                  !local.some(
                    (c) =>
                      c.pubkey === a && c.managed && c.execution !== "remote",
                  )),
            )
          )
            throw new Error(
              "An approved local agent is not available on this device.",
            );
          await source(state);
          await emit(
            { type: "ready", move, nonce: probe.control.nonce, worker },
            `ready:${probe.control.nonce}`,
          );
          state = current(requestId) ?? state;
        }
        if (
          !initiates(state) ||
          state.ready.length !== state.approvers.length ||
          !state.probe ||
          now() > state.probe.event.created_at + 15
        )
          return;
        state = await fresh(requestId);
        if (
          state.status !== "approved" ||
          state.ready.length !== state.approvers.length
        )
          return;
        await validate(state);
        await source(state);
        const probeNonce =
          state.probe?.control.type === "probe"
            ? state.probe.control.nonce
            : undefined;
        if (
          !probeNonce ||
          now() > (state.probe?.event.created_at ?? 0) + 15 ||
          state.ready.length !== state.approvers.length ||
          state.approvers.some(
            (p) =>
              p !== session.viewer && session.presence.status(p) !== "online",
          ) ||
          current(requestId)?.probe?.event.id !== state.probe?.event.id ||
          current(requestId)?.status !== "approved"
        )
          return;
        await emit({
          type: "commit",
          move,
          nonce: probeNonce,
          through: Date.now(),
        });
        state = current(requestId) ?? state;
      }
      if (state.status === "committing" && initiates(state)) {
        // The durable commit is the posting boundary. Cancel is disabled before any target operation.
        for (const [author] of req.authors)
          if (!channel(req.target)?.members?.includes(author))
            await addChannelMember(
              session,
              req.target,
              author,
              lifetime.signal,
            );
        const names = req.authors
          .filter(([a, o]) => a === o)
          .map(
            ([a]) => session.profiles.snapshot().get(a)?.name ?? a.slice(0, 8),
          );
        const root = await send(
          {
            kind: 9,
            content: `Moved from a DM with ${names.join(", ")}`,
            tags: [
              ["h", req.target],
              ["buzz:dm-move-root", move],
            ],
          },
          `${requestId}:root`,
        );
        const nonce =
          state.probe?.control.type === "probe"
            ? state.probe.control.nonce
            : undefined;
        if (!nonce) throw new Error("The readiness check is unavailable.");
        await emit({ type: "go", move, root, nonce });
        state = current(requestId) ?? state;
      }
      if (state.status !== "posting" || !owns(state) || !state.root) return;
      await session.channelWrites.refreshMembership(req.target);
      await validate(state, true);
      // Read accepted copies first: a child may be authored by a different app.
      const copies = await readAll({
        kinds: [9],
        "#h": [req.target],
        "#e": [state.root],
        consistency: "strong",
        limit: 200,
      });
      const mapping = new Map<string, string>();
      for (const copy of copies) {
        const source = movedSource(copy);
        if (
          source?.move === move &&
          req.authors.some(([a]) => a === copy.pubkey)
        )
          mapping.set(source.original, copy.id);
      }
      const epoch = sourceEpochs.get(state.request.dm);
      const connection = connectionEpoch;
      const plan = await source(state);
      const checkedAt = Date.now();
      let publishingCopies = true;
      const eligible = () =>
        publishingCopies &&
        active() &&
        sourceEpochs.get(state.request.dm) === epoch &&
        connectionEpoch === connection &&
        Date.now() - checkedAt < 15_000;
      const expected = new Map(plan.map((m) => [m.original, m.author]));
      for (const [original] of mapping)
        if (
          !copies.some(
            (e) =>
              movedSource(e)?.original === original &&
              expected.get(original) === e.pubkey,
          )
        )
          mapping.delete(original);
      const mine = plan.filter((m) =>
        req.authors.some(([a, o]) => a === m.author && o === session.viewer),
      );
      try {
        for (const message of mine) {
          if (mapping.has(message.original)) continue;
          if (message.parent && !mapping.has(message.parent)) continue;
          const template = movedTemplate(
            req,
            message,
            state.root,
            message.parent
              ? (mapping.get(message.parent) ?? state.root)
              : state.root,
          );
          const key = `${requestId}:copy:${message.original}`;
          const id =
            message.author === session.viewer
              ? await send(template, key, eligible)
              : await agentSend(state, message.author, template, key, eligible);
          mapping.set(message.original, id);
        }
      } finally {
        publishingCopies = false;
      }
      if (mine.every((m) => mapping.has(m.original)))
        await emit({ type: "done", move, worker });
    });
  }
  function schedule(delay = 0) {
    if (!active()) return;
    // Record the wakeup synchronously: a live event arriving just before the
    // current pass ends must not be overwritten by its long backstop timer.
    if (running) {
      queued = true;
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(
      () => void tick(),
      Math.max(delay, retryAt - Date.now()),
    );
  }
  async function tick() {
    if (!active()) return;
    if (running) {
      queued = true;
      return;
    }
    if (!hydrated || session.live.snapshot().status !== "connected") return;
    running = true;
    try {
      publish();
      const errors: string[] = [];
      for (const state of snapshot.moves) {
        if (terminal.has(state.status)) continue;
        try {
          await advance(state);
        } catch (error) {
          errors.push(String(error));
        }
      }
      if (errors.length) throw new Error(errors.join("; "));
      failures = 0;
      retryAt = 0;
    } catch (error) {
      if (active()) {
        retryAt =
          Date.now() +
          Math.min(300_000, 5000 * 2 ** Math.min(failures++, 6)) +
          Math.random() * 1000;
        publish(String(error));
      }
    } finally {
      running = false;
      if (active()) {
        const pending = snapshot.moves.filter((m) => !terminal.has(m.status));
        const expiry = Math.min(
          ...pending
            .filter((m) => m.status === "pending")
            .map((m) => m.request.control.expires * 1000 - Date.now()),
        );
        const working = pending.some(
          (m) =>
            m.status === "posting" ||
            m.status === "committing" ||
            m.status === "approved",
        );
        if (queued) {
          queued = false;
          schedule();
        } else if (working || Number.isFinite(expiry))
          schedule(
            Math.max(
              100,
              Math.min(
                working ? 30_000 + Math.random() * 3000 : Infinity,
                expiry,
              ),
            ),
          );
      }
    }
  }
  const stopLive = session.subscribeLive(
    ({ events }) => {
      for (const event of events) {
        if (
          ![9, 40002, 40003, 5, 9005].includes(event.kind) ||
          moveControl(event)
        )
          continue;
        const dm = event.tags.find(([k]) => k === "h")?.[1];
        if (dm && channel(dm)?.channelType === "dm")
          sourceEpochs.set(dm, (sourceEpochs.get(dm) ?? 0) + 1);
      }
      receive(events);
      if (events.some((e) => moveControl(e) || movedSource(e))) {
        try {
          save();
          publish();
          schedule();
        } catch (e) {
          publish(String(e));
        }
      }
    },
    { replay: true, dmMoves: true },
  );
  const stopRoster = session.channels.subscribeList(() => {
    if (!hydrated && session.channels.list().status === "ready")
      void hydrate()
        .then(() => schedule())
        .catch(() => {});
  });
  let connectionStatus = session.live.snapshot().status;
  const stopConnection = session.live.subscribe(() => {
    const status = session.live.snapshot().status;
    if (status === connectionStatus) return;
    connectionStatus = status;
    connectionEpoch++;
    if (session.live.snapshot().status === "connected")
      void hydrate()
        .then(() => schedule(250 + Math.random() * 750))
        .catch(() => {});
  });
  void hydrate()
    .then(() => schedule())
    .catch(() => {});
  publish();
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    worker,
    async start(
      dmId: string,
      targetId: string,
      hours: number,
      from?: { id: string; ms: number },
    ) {
      await session.channelWrites.refreshMembership(dmId);
      await session.channelWrites.refreshMembership(targetId);
      const dm = channel(dmId),
        target = channel(targetId);
      if (
        !dm?.members ||
        !session.viewer ||
        !Number.isFinite(hours) ||
        hours < 1 / 60 ||
        hours > 720
      )
        throw new Error(
          "Choose an approval window between one minute and 30 days.",
        );
      await session.profiles.ensure(dm.members, "foreground");
      const owners = new Map(
        await Promise.all(
          dm.members.map(async (p) => [p, await verifiedOwner(p)] as const),
        ),
      );
      if (
        dm.members.some(
          (p) => session.profiles.snapshot().get(p)?.isAgent && !owners.get(p),
        )
      )
        throw new Error("An agent’s owner could not be verified.");
      const authors = dm.members.map(
        (author) => [author, owners.get(author) ?? author] as const,
      );
      if (authors.some(([a, o]) => a !== o && !dm.members?.includes(o)))
        throw new Error("Every agent’s owner must be in the DM.");
      validateMoveChannels(
        dm,
        target,
        authors.map((p) => p[0]),
      );
      const req: MoveRequest = {
        type: "request",
        move: crypto.randomUUID(),
        worker,
        target: targetId,
        expires: now() + Math.ceil(hours * 3600),
        authors,
        ...(from ? { from } : {}),
      };
      const fake = {
        request: { event: { pubkey: session.viewer }, dm: dmId, control: req },
      } as MoveState;
      if (!(await source(fake)).length)
        throw new Error(
          "Choose a conversation containing messages to convert.",
        );
      const requestId = await control(dmId, req);
      await control(
        dmId,
        { type: "approve", move: req.move, worker },
        "approve",
        requestId,
      );
      schedule();
      return requestId;
    },
    async respond(requestId: string, approve: boolean, reason = "") {
      const state = await fresh(requestId);
      if (
        state.status !== "pending" ||
        !state.approvers.includes(session.viewer ?? "")
      )
        throw new Error("This conversion is no longer awaiting your approval.");
      if (approve) {
        await validate(state);
        await source(state);
      }
      await control(
        state.request.dm,
        {
          type: approve ? "approve" : "decline",
          move: state.request.control.move,
          ...(approve ? { worker } : { reason: reason.trim() }),
        },
        approve ? "approve" : "decline",
        requestId,
      );
      schedule();
    },
    async cancel(requestId: string) {
      await locked(requestId, async () => {
        const state = await fresh(requestId);
        if (
          state.request.event.pubkey !== session.viewer ||
          !["pending", "approved"].includes(state.status) ||
          journal.receipts[`${requestId}:root`] ||
          journal.receipts[`${requestId}:${session.viewer}:commit`]
        )
          throw new Error(
            "This conversion has already started posting or cannot be cancelled by you.",
          );
        await control(
          state.request.dm,
          { type: "cancel", move: state.request.control.move },
          "cancel",
          requestId,
        );
      });
    },
    retry() {
      retryAt = 0;
      void hydrate()
        .then(() => schedule())
        .catch(() => {});
    },
    dispose() {
      lifetime.abort();
      clearTimeout(timer);
      stopLive();
      stopRoster();
      stopConnection();
      for (const stop of presence.values()) stop();
      presence.clear();
      listeners.clear();
    },
  };
}
export type DmMoves = ReturnType<typeof createDmMoves>;
const owners = new WeakMap<RelaySession, DmMoves>();
export const dmMoves = (session: RelaySession) => owners.get(session);
/** The bundled plugin owns background work, independently of its page's mounted state. */
export function bindDmMoves(relay: RelayData, agentHost?: MoveAgentHost) {
  let owned: RelaySession | undefined;
  const update = () => {
    const { session, cached, status } = relay.snapshot();
    if (session === owned) return;
    if (owned) {
      owners.get(owned)?.dispose();
      owners.delete(owned);
      owned = undefined;
    }
    if (status === "ready" && !cached && session.viewer && session.outbox) {
      owned = session;
      owners.set(session, createDmMoves(session, agentHost));
    }
  };
  const stop = relay.subscribe(update);
  update();
  return () => {
    stop();
    if (owned) {
      owners.get(owned)?.dispose();
      owners.delete(owned);
    }
  };
}

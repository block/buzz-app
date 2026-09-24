import type { Outbox, LocalEvents } from "../relay/outbox";
import type { KitEntry } from "./model";
import { object, parseLineup } from "./model";
export type ChannelSetup = {
  canvas: string;
  agents: string[];
  groupId: string;
  templateId: string;
};
export type ChannelCreationInput = Readonly<{
  name: string;
  description?: string | undefined;
  visibility: "open" | "private";
  ttlSeconds?: number | undefined;
  setup?: ChannelSetup | undefined;
}>;
type Progress = {
  version: 1;
  id: string;
  input: ChannelCreationInput;
  created: boolean;
  canvasDone: boolean;
  added: string[];
  accepted: string[];
  operations: Record<string, string>;
  complete: boolean;
};

/** One bounded setup receipt, not delivery storage. Delivery stays in the session outbox. */
export function createChannelSetup({
  scope,
  outbox,
  local,
  create,
  delivered,
  confirm,
  refresh,
  canvasHead,
  place,
  preflight,
  signal,
}: {
  scope: string;
  outbox: Outbox;
  local: LocalEvents;
  create(id: string, input: ChannelCreationInput): string;
  delivered(id: string): Promise<void>;
  confirm(id: string): Promise<void>;
  refresh(id: string, member: string): Promise<void>;
  canvasHead(id: string): Promise<string | undefined>;
  place(id: string, group: string): Promise<void>;
  preflight(input: ChannelCreationInput): Promise<void>;
  signal: AbortSignal;
}) {
  const key = `buzz-channel-setup.v1:${scope}`;
  const listeners = new Set<() => void>();
  let pending: Progress | undefined;
  let storageError: string | undefined;
  let running = false;
  function load() {
    try {
      storageError = undefined;
      const raw = localStorage.getItem(key);
      if (!raw) return undefined;
      const v = object(JSON.parse(raw)),
        input = object(v.input);
      if (
        v.version !== 1 ||
        typeof v.id !== "string" ||
        !/^[0-9a-f-]{36}$/.test(v.id) ||
        typeof input.name !== "string" ||
        !["open", "private"].includes(String(input.visibility)) ||
        typeof v.created !== "boolean" ||
        typeof v.canvasDone !== "boolean" ||
        typeof v.complete !== "boolean" ||
        !Array.isArray(v.added) ||
        v.added.some(
          (a) => typeof a !== "string" || !/^[0-9a-f]{64}$/.test(a),
        ) ||
        Object.values(object(v.operations)).some(
          (id) => typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id),
        )
      )
        throw new Error("Invalid saved channel setup");
      if (input.setup) {
        const setup = object(input.setup);
        parseLineup({ ...setup, teamIds: [] });
        if (
          typeof setup.groupId !== "string" ||
          typeof setup.templateId !== "string"
        )
          throw new Error("Invalid saved channel setup destination");
      }
      if (
        !Array.isArray(v.accepted) ||
        v.accepted.some(
          (a) => typeof a !== "string" || !/^[0-9a-f]{64}$/.test(a),
        )
      )
        throw new Error("Invalid saved membership outcomes");
      const setup = input.setup ? object(input.setup) : undefined;
      const agents = (setup?.agents ?? []) as string[];
      if (
        (v.added as string[]).some((key) => !agents.includes(key)) ||
        (v.accepted as string[]).some((key) => !agents.includes(key))
      )
        throw new Error(
          "Saved membership outcome does not match the frozen lineup",
        );
      const operations = object(v.operations);
      if (
        Object.keys(operations).some(
          (step) =>
            ![
              "create",
              "canvas",
              ...agents.map((key) => `member:${key}`),
            ].includes(step),
        )
      )
        throw new Error("Invalid saved setup step");
      return v as unknown as Progress;
    } catch (error) {
      storageError = String(error);
      return undefined;
    }
  }
  pending = load();
  const save = (value: Progress) => {
    signal.throwIfAborted();
    // Unlike view-state, storage failures are visible and stop remote continuation.
    const bytes = JSON.stringify(value);
    if (bytes.length > 64 * 1024)
      throw new Error("Channel setup exceeds its local receipt budget");
    localStorage.setItem(key, bytes);
    pending = value;
    listeners.forEach((l) => {
      l();
    });
  };
  const operation = (
    p: Progress,
    step: string,
    kind: number,
    content: string,
    tags: string[][],
    send?: () => string,
  ) => {
    const existing = p.operations[step];
    if (existing) return existing;
    // A crash after outbox enqueue but before linking the receipt recovers the same h-scoped operation.
    const previous = local
      .snapshot()
      .find(
        (item) =>
          item.event.kind === kind &&
          item.event.content === content &&
          tags.every((tag) =>
            item.event.tags.some((t) => t[0] === tag[0] && t[1] === tag[1]),
          ),
      );
    const id =
      previous?.event.id ??
      (send ? send() : outbox.send({ kind, content, tags }));
    p.operations[step] = id;
    save(p);
    return id;
  };
  return Object.freeze({
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => (pending && !pending.complete ? pending.input : undefined),
    channelId: () =>
      pending && !pending.complete && pending.created ? pending.id : undefined,
    completedId: () => (pending?.complete ? pending.id : undefined),
    async run(input: ChannelCreationInput, viewer: string) {
      if (!navigator.locks)
        throw new Error(
          "This browser cannot safely coordinate channel setup; use a current browser",
        );
      if (running) throw new Error("Channel setup is already running");
      running = true;
      try {
        return await navigator.locks.request(
          key,
          { mode: "exclusive", ifAvailable: true },
          async (lock) => {
            signal.throwIfAborted();
            if (!lock)
              throw new Error("Another window is completing channel setup");
            pending = load();
            if (storageError)
              throw new Error(
                `Channel setup storage needs attention: ${storageError}`,
              );
            let p = pending;
            if (!p || p.complete) {
              await preflight(input);
              p = {
                version: 1,
                id: crypto.randomUUID(),
                input: structuredClone(input),
                created: false,
                canvasDone: false,
                added: [],
                accepted: [],
                operations: {},
                complete: false,
              };
              save(p); // Freeze destination and intent before any remote side effect.
            } else if (JSON.stringify(input) !== JSON.stringify(p.input))
              throw new Error(
                "Another channel setup is unfinished. Resume it without changing its frozen details.",
              );
            const current = p;
            const setup = p.input.setup;
            if (!p.created) {
              let id: string;
              try {
                id = operation(p, "create", 9007, "", [["h", p.id]], () =>
                  create(current.id, current.input),
                );
              } catch (error) {
                if (
                  !Object.keys(p.operations).length &&
                  !local
                    .snapshot()
                    .some((item) =>
                      item.event.tags.some(
                        (t) => t[0] === "h" && t[1] === current.id,
                      ),
                    )
                ) {
                  localStorage.removeItem(key);
                  pending = undefined;
                  listeners.forEach((l) => {
                    l();
                  });
                }
                throw error;
              }
              try {
                await delivered(id);
                await refresh(p.id, viewer);
                p.created = true;
                save(p);
              } catch (error) {
                const failed =
                  local.snapshot().find((item) => item.event.id === id)
                    ?.delivery === "failed";
                if (failed) {
                  await outbox.dismiss(id);
                  localStorage.removeItem(key);
                  pending = undefined;
                  listeners.forEach((l) => {
                    l();
                  });
                }
                throw error;
              }
            }
            try {
              await refresh(p.id, viewer);
              if (setup?.canvas && !p.canvasDone) {
                const head = await canvasHead(p.id),
                  saved = p.operations.canvas;
                if (head && head !== saved)
                  throw new Error(
                    "Canvas has a different saved document. Keep this channel and resolve Canvas explicitly; no agents were added by this attempt.",
                  );
                const id = operation(p, "canvas", 40100, setup.canvas, [
                  ["h", p.id],
                ]);
                await confirm(id);
                if ((await canvasHead(p.id)) !== id)
                  throw new Error(
                    "The seed Canvas is not the selected document; resolve it before adding agents",
                  );
                p.canvasDone = true;
                save(p);
              }
              if (
                setup?.canvas &&
                (await canvasHead(p.id)) !== p.operations.canvas
              )
                throw new Error(
                  "Canvas changed after seeding. Keep the partial channel and resolve its setup explicitly before adding more agents.",
                );
              for (const agent of setup?.agents ?? []) {
                if (agent === viewer || p.added.includes(agent)) continue;
                const step = `member:${agent}`;
                const id = operation(p, step, 9000, "", [
                  ["h", p.id],
                  ["p", agent],
                ]);
                if (!p.accepted.includes(agent)) {
                  await confirm(id);
                  p.accepted.push(agent);
                  save(p);
                }
                // Accepted without roster proof is unresolved. Resume only reads the roster;
                // it never replays a confirmed command to restore a deliberately removed agent.
                await refresh(p.id, agent);
                p.added.push(agent);
                save(p);
              }
              if (setup?.groupId) await place(p.id, setup.groupId);
              const creation = p.operations.create;
              if (creation) await outbox.dismiss(creation);
              p.complete = true;
              save(p);
              return p.id;
            } catch (error) {
              throw new Error(
                `Channel created; setup incomplete. Resume this same channel (${p.id}). ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          },
        );
      } finally {
        running = false;
      }
    },
    async keepPartial() {
      if (!navigator.locks || running)
        throw new Error("Wait for the current setup attempt to finish");
      return navigator.locks.request(
        key,
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          signal.throwIfAborted();
          if (!lock)
            throw new Error("Another window is completing channel setup");
          pending = load();
          if (storageError || !pending?.created)
            throw new Error(
              storageError ?? "Channel creation is not confirmed yet",
            );
          if (
            Object.values(pending.operations).some((id) =>
              outbox
                .snapshot()
                .some(
                  (item) => item.event.id === id && item.delivery === "sending",
                ),
            )
          )
            throw new Error(
              "Wait for in-flight writes before keeping the partial channel",
            );
          const id = pending.id;
          if (pending.operations.create)
            await outbox.dismiss(pending.operations.create);
          save({ ...pending, complete: true });
          return id;
        },
      );
    },
  });
}

export function personalGroups(entries: readonly KitEntry[]) {
  return entries.find(
    (e) => !e.record.deleted && e.record.value.type === "groups",
  );
}

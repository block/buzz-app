import type { Outbox, LocalEvents } from "../relay/outbox";
import { isDefinitiveCanvasConflict } from "./canvas-conflict";
import { errorMessage } from "../../shared/error-message";

/** Create's answer when it can't tell which of a template's agents are
 * available. The dialog's template field shows it with its Retry. */
export const TEMPLATE_AGENTS_UNCHECKED =
  "Buzz couldn’t check this template’s agents. Try again, or choose None to create the channel without them.";

/** What a template's setup left undone once its channel exists. */
export type SetupMissing = Readonly<{
  /** The sidebar place it was meant to go. */
  placement?: "starred" | "group" | undefined;
  canvas: boolean;
  /** Agents it didn't add. */
  agents: readonly string[];
  /** Buzz only rechecked the channel, so these may have happened anyway. */
  uncertain?: true | undefined;
}>;

/** The channel exists, but some of its setup didn't finish. People see
 * what's missing, by name (describeMissingSetup); the message, which only
 * logs show, keeps why. */
export class SetupIncomplete extends Error {
  constructor(
    readonly missing: SetupMissing,
    why: unknown,
    options?: ErrorOptions,
  ) {
    super(
      [why]
        .flat()
        .map((reason) => errorMessage(reason))
        .join("; "),
      options,
    );
  }
}

/** Everything a setup still had to do, from what it recorded as done. */
function missingSetup(
  setup: ChannelSetup | undefined,
  viewer: string,
  done: Pick<Progress, "groupDone" | "canvasDone" | "added">,
): SetupMissing {
  return {
    placement: done.groupDone
      ? undefined
      : setup?.starred
        ? "starred"
        : setup?.groupId
          ? "group"
          : undefined,
    canvas: !!setup?.canvas && !done.canvasDone,
    agents: (setup?.agents ?? []).filter(
      (agent) => agent !== viewer && !done.added.includes(agent),
    ),
  };
}

/** Whether anything is missing at all. */
export const setupMissing = (missing: SetupMissing) =>
  !!missing.placement || missing.canvas || missing.agents.length > 0;
export type ChannelSetup = {
  canvas: string;
  agents: string[];
  groupId: string;
  starred?: boolean;
  templateId: string;
};
export type ChannelCreationInput = Readonly<{
  name: string;
  description?: string | undefined;
  visibility: "open" | "private";
  ttlSeconds?: number | undefined;
  /** NIP-CL labels to create the channel with. */
  labels?: readonly string[] | undefined;
  /** Create a NIP-CL system channel: left out of channel lists. */
  system?: true | undefined;
  setup?: ChannelSetup | undefined;
}>;
/** Whether a request asks for anything beyond the channel itself. A template
 * that currently resolves to nothing still names itself in `setup`. */
export const setupWork = (setup: ChannelSetup | undefined) =>
  !!setup &&
  !!(setup.canvas || setup.agents.length || setup.groupId || setup.starred);
/** What the person chose. The agents and Canvas follow live inventory and the
 * template's contents, so they cannot make an unchanged form look new. */
const requested = ({ setup, ...input }: ChannelCreationInput) =>
  JSON.stringify({
    ...input,
    setup: setup && {
      templateId: setup.templateId,
      groupId: setup.groupId,
      starred: setup.starred,
    },
  });
type Progress = {
  version: 2;
  id: string;
  input: ChannelCreationInput;
  created: boolean;
  groupDone: boolean;
  canvasDone: boolean;
  added: string[];
  accepted: string[];
  operations: Record<string, string>;
};

const receiptPrefix = (scope: string) => `buzz-channel-setup.v2:${scope}:`;

/** Drops one community's unfinished setup receipts once the viewer has left it;
 * their operations have no outbox left to retire against. */
export function forgetChannelSetups(scope: string) {
  const prefix = receiptPrefix(scope);
  const stale: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) stale.push(key);
  }
  for (const key of stale) localStorage.removeItem(key);
}

/** Frozen intent only. Signing, publication and delivery evidence stay in Outbox. */
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
  star,
  preflight,
  signal,
  changed,
}: {
  scope: string;
  outbox: Outbox;
  local: LocalEvents;
  create(
    id: string,
    input: ChannelCreationInput,
    active: () => boolean,
  ): string;
  /** An active gate permits explicit retry of this exact uncertain Create only. */
  delivered(id: string, active?: () => boolean): Promise<void>;
  /** Observe/read back only; never retry template publications. */
  confirm(id: string): Promise<void>;
  /** Wait for relay roster proof that `member` is in the channel `input` made. */
  refresh(
    id: string,
    member: string,
    input: ChannelCreationInput,
  ): Promise<void>;
  canvasHead(id: string): Promise<string | undefined>;
  place(id: string, group: string): Promise<void>;
  star(id: string): Promise<void>;
  preflight(input: ChannelCreationInput): Promise<void>;
  signal: AbortSignal;
  changed(): void;
}) {
  // A separate namespace leaves historical single-slot and experimental v1
  // receipts byte-for-byte intact. They never become an implicit new Create.
  const prefix = receiptPrefix(scope);
  const encoder = new TextEncoder();
  let pending: Progress | undefined;
  let admitting: ReturnType<typeof run> | undefined;
  let admittingRequest: string | undefined;
  function write(p: Progress) {
    const raw = JSON.stringify(p);
    signal.throwIfAborted();
    let count = 1,
      bytes = encoder.encode(raw).byteLength;
    if (bytes > 64 * 1024)
      throw new Error("Channel setup exceeds its local receipt budget");
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix) || key === prefix + p.id) continue;
      count++;
      bytes += encoder.encode(localStorage.getItem(key) ?? "").byteLength;
    }
    if (count > 256 || bytes > 2 * 1024 * 1024)
      throw new Error(
        "Too many unfinished channel setups on this device. No new setup write was sent.",
      );
    // setItem is atomic on failure. Never remove/overwrite the last receipt
    // as a fallback, and never continue remote writes after a failed save.
    localStorage.setItem(prefix + p.id, raw);
  }
  const save = (p: Progress) =>
    navigator.locks.request(prefix, { signal }, () => write(p));
  async function retire(p: Progress) {
    for (const id of Object.values(p.operations)) {
      await outbox.dismiss(id);
      if (outbox.snapshot().some((item) => item.event.id === id))
        throw new Error("Channel setup delivery evidence could not be retired");
    }
    signal.throwIfAborted();
    localStorage.removeItem(prefix + p.id);
    if (pending === p) {
      pending = undefined;
      changed();
    }
  }
  function run(
    input: ChannelCreationInput,
    viewer: string,
  ): { admission: Promise<string>; completion: Promise<void> } {
    if (admitting) {
      if (admittingRequest === requested(input)) return admitting;
      // A different request waits its turn instead of sharing this admission.
      const next = admitting.admission
        .then(
          () => {},
          () => {},
        )
        .then(() => {
          // Queued work never abandons an unconfirmed attempt; only a request
          // its owner makes may.
          if (pending && requested(pending.input) !== requested(input))
            throw new Error(
              "Another channel's creation is unconfirmed; try again shortly",
            );
          return run(input, viewer);
        });
      return {
        admission: next.then((queued) => queued.admission),
        completion: next.then((queued) => queued.completion),
      };
    }
    // Only an identical request rechecks the unconfirmed attempt; any other
    // request abandons it.
    const checking =
      pending && requested(pending.input) === requested(input)
        ? pending
        : undefined;
    if (!checking) forget();

    let opened!: (id: string) => void;
    let rejected!: (reason: unknown) => void;
    const admission = new Promise<string>((resolve, reject) => {
      opened = resolve;
      rejected = reject;
    });
    const completion = (async () => {
      if (!navigator.locks)
        throw new Error(
          "This browser cannot safely coordinate channel setup; use a current browser",
        );
      if (checking) {
        // Explicit recovery may retry only the saved Create, never a new UUID
        // or the remaining template writes. Renew its revoked admission gate.
        const operation = checking.operations.create;
        if (!operation)
          throw new Error(
            "Channel creation was not saved. Reconnect before checking it.",
          );
        let retrying = true;
        try {
          await delivered(operation, () => retrying && !signal.aborted);
          await refresh(checking.id, viewer, checking.input);
        } catch (error) {
          if (
            local
              .snapshot()
              .some(
                (item) =>
                  item.event.id === operation && item.delivery === "failed",
              )
          )
            await retire(checking);
          throw error;
        } finally {
          retrying = false;
        }
        checking.created = true;
        pending = undefined;
        changed();
        opened(checking.id);
        // Only the Create is rechecked, so the rest is left for the person.
        // A placement started before its admission failed may have landed.
        const uncertain = () => ({
          ...missingSetup(checking.input.setup, viewer, checking),
          uncertain: true as const,
        });
        try {
          await save(checking);
          if (setupWork(checking.input.setup))
            throw new SetupIncomplete(
              uncertain(),
              "Channel confirmed. Template setup was not continued.",
            );
          await retire(checking);
        } catch (error) {
          // As on the main path: once the channel exists, every failure is
          // setup it didn't finish, so its notice still shows.
          if (error instanceof SetupIncomplete) throw error;
          throw new SetupIncomplete(uncertain(), error, { cause: error });
        }
        return;
      }
      await preflight(input);
      const p: Progress = {
        version: 2,
        id: crypto.randomUUID(),
        input: structuredClone(input),
        created: false,
        groupDone: false,
        canvasDone: false,
        added: [],
        accepted: [],
        operations: {},
      };
      await save(p); // Reserve frozen intent before enqueueing anything.
      pending = p;
      changed();
      await navigator.locks.request(prefix + p.id, { signal }, async () => {
        let writable = true;
        let storageHealthy = true;
        const persist = async () => {
          try {
            await save(p);
          } catch (error) {
            storageHealthy = false;
            writable = false;
            throw error;
          }
        };
        const active = () => writable && !signal.aborted;
        const operation = async (
          step: string,
          kind: number,
          content: string,
          tags: string[][],
          send?: () => string,
        ) => {
          signal.throwIfAborted();
          const existing = p.operations[step];
          if (existing) return existing;
          const previous = local
            .snapshot()
            .find(
              (item) =>
                item.event.kind === kind &&
                item.event.content === content &&
                tags.every((tag) =>
                  item.event.tags.some(
                    (t) => t[0] === tag[0] && t[1] === tag[1],
                  ),
                ),
            );
          return navigator.locks.request(prefix, { signal }, () => {
            try {
              const id =
                previous?.event.id ??
                (send
                  ? send()
                  : outbox.send({ kind, content, tags }, undefined, active));
              p.operations[step] = id;
              try {
                write(p);
              } catch (error) {
                storageHealthy = false;
                throw error;
              }
              return id;
            } catch (error) {
              // Revoke before Outbox can advance past its enqueue microtask.
              writable = false;
              throw error;
            }
          });
        };
        try {
          const id = await operation("create", 9007, "", [["h", p.id]], () =>
            create(p.id, p.input, active),
          );
          await delivered(id);
          // Place before the row first lists, so it renders in its destination
          // and the creation reveal targets that entry.
          const setup = p.input.setup;
          const placement = setup?.starred
            ? star(p.id)
            : setup?.groupId
              ? place(p.id, setup.groupId)
              : undefined;
          // Observed after admission. If admission fails its result is dropped,
          // but the delivered channel still lists in its destination.
          placement?.catch(() => {});
          await refresh(p.id, viewer, p.input);
          p.created = true;
          pending = undefined;
          changed();
          // The original form owns admission until this exact channel is usable.
          // A subsequent storage/setup failure belongs to its completion notice.
          opened(p.id);
          await persist();
          let placementError: unknown;
          try {
            await placement;
          } catch (error) {
            placementError = error;
          }
          if (!placementError) {
            p.groupDone = true;
            await persist();
          }
          try {
            if (setup?.canvas && !p.canvasDone) {
              const head = await canvasHead(p.id);
              if (head && head !== p.operations.canvas)
                throw new Error(
                  "Canvas has a different saved document; no agents were added by this attempt.",
                );
              const canvas = await operation("canvas", 40100, setup.canvas, [
                ["h", p.id],
                ["expected-revision", "none"],
              ]);
              try {
                await confirm(canvas);
              } catch (error) {
                const failed = local
                  .snapshot()
                  .find((item) => item.event.id === canvas);
                if (isDefinitiveCanvasConflict(failed)) {
                  // A refused seed must not fence a later manual Canvas save.
                  await outbox.dismiss(canvas);
                  throw new Error(
                    "Canvas changed before the seed was saved; no agents were added by this attempt.",
                  );
                }
                throw error;
              }
              if ((await canvasHead(p.id)) !== canvas)
                throw new Error(
                  "The seed Canvas is not the selected document; no agents were added by this attempt.",
                );
              p.canvasDone = true;
              await persist();
            }
            if (
              setup?.canvas &&
              (await canvasHead(p.id)) !== p.operations.canvas
            )
              throw new Error(
                "Canvas changed after seeding; no more agents were added by this attempt.",
              );
            for (const agent of setup?.agents ?? []) {
              if (agent === viewer || p.added.includes(agent)) continue;
              const member = await operation(`member:${agent}`, 9000, "", [
                ["h", p.id],
                ["p", agent],
              ]);
              if (!p.accepted.includes(agent)) {
                await confirm(member);
                p.accepted.push(agent);
                await persist();
              }
              // Accepted without roster proof stays unresolved. Never restore a
              // deliberately removed member by replaying a confirmed command.
              await refresh(p.id, agent, p.input);
              p.added.push(agent);
              await persist();
            }
          } catch (error) {
            const why = placementError ? [placementError, error] : error;
            throw new SetupIncomplete(missingSetup(setup, viewer, p), why, {
              cause: why,
            });
          }
          if (placementError)
            throw new SetupIncomplete(
              missingSetup(setup, viewer, p),
              placementError,
              { cause: placementError },
            );
          await retire(p);
        } catch (error) {
          writable = false;
          // Once the channel exists, every failure is setup it didn't finish.
          if (p.created && !(error instanceof SetupIncomplete))
            throw new SetupIncomplete(
              missingSetup(p.input.setup, viewer, p),
              error,
              { cause: error },
            );
          if (!p.created && storageHealthy) {
            const operation = p.operations.create;
            const failed =
              local.snapshot().find((item) => item.event.id === operation)
                ?.delivery === "failed";
            const noWrite =
              !Object.keys(p.operations).length &&
              !local
                .snapshot()
                .some((item) =>
                  item.event.tags.some((t) => t[0] === "h" && t[1] === p.id),
                );
            if (failed || noWrite) await retire(p);
          }
          throw error;
        } finally {
          writable = false;
        }
      });
    })();
    // Completion and admission are separate outcomes of the same run, not two
    // schedulers. The session owns completion even after the form has closed.
    void completion.catch(rejected);
    const result = { admission, completion };
    admitting = result;
    admittingRequest = requested(input);
    void admission
      .finally(() => {
        if (admitting === result) admitting = undefined;
      })
      .catch(() => {});
    return result;
  }
  /** Drops an unconfirmed attempt; one being checked continues. */
  function forget() {
    const abandoned = pending;
    if (!abandoned || admitting) return;
    pending = undefined;
    void retire(abandoned).catch(() => {});
  }
  return Object.freeze({ run, forget });
}

/** "a", "a or b", "a, b, or c". */
function orList(items: readonly string[]) {
  return items.length < 3
    ? items.join(" or ")
    : `${items.slice(0, -1).join(", ")}, or ${items.at(-1)}`;
}

/** What a setup left undone, in one sentence: "Buzz couldn’t add Atlas or
 * start the Canvas." `nameOf` names an agent when Buzz knows them. */
export function describeMissingSetup(
  missing: SetupMissing,
  nameOf: (pubkey: string) => string | undefined,
) {
  const { agents, uncertain } = missing;
  // Each step as "Buzz couldn’t …" and "Buzz may not have …" finish it.
  const steps: (readonly [string, string])[] = [];
  if (agents.length) {
    const names = agents.map(nameOf);
    const who = names.every(Boolean)
      ? new Intl.ListFormat(undefined, { type: "conjunction" }).format(
          names as string[],
        )
      : agents.length > 1
        ? `${agents.length} agents`
        : "an agent";
    steps.push([`add ${who}`, `added ${who}`]);
  }
  if (missing.canvas) steps.push(["start the Canvas", "started the Canvas"]);
  if (missing.placement === "starred")
    steps.push(["star the channel", "starred the channel"]);
  if (missing.placement === "group")
    steps.push([
      "put the channel in its sidebar group",
      "put the channel in its sidebar group",
    ]);
  if (!steps.length) return "";
  return `${uncertain ? "Buzz may not have" : "Buzz couldn’t"} ${orList(
    steps.map(([undone, unsure]) => (uncertain ? unsure : undone)),
  )}.`;
}

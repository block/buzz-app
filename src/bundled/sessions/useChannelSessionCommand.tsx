import {
  useCallback,
  useSyncExternalStore,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MentionDraft } from "../../features/messages/mention-draft";
import type { RelaySession } from "../../features/relay/session";
import type { VisibleEvent } from "../../features/relay/projection";
import { eventDto } from "../../features/relay/events";
import {
  sessionCommandDraft,
  type SessionCommandHandler,
} from "../../features/sessions/session-command";
import { Button } from "../../shared/design-system/ui/Button";
import { channelSessionRecipients } from "./channel-session-creation";
import {
  clearChannelSessionDraft,
  matchesChannelSessionDraft,
  readChannelSessionDraft,
  readChannelSessionEditorGeneration,
  saveChannelSessionDraft,
  saveChannelSessionEditorGeneration,
  withChannelSessionDraftLock,
  type ChannelSessionDraft,
} from "./channel-session-draft";

export type SessionCommandLease = {
  valid(): boolean;
  open(rootId: string): boolean;
  dispose(): void;
};
const noSubscription = () => () => {};
const empty = [] as const;
const emptySnapshot = () => empty;
const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

/** One command intent, not a second editor or outbox. Mounting never publishes. */
export function useChannelSessionCommand({
  session,
  scope,
  channelId,
  lease,
}: {
  session: RelaySession;
  scope: string;
  channelId: string | undefined;
  lease(): SessionCommandLease | undefined;
}): SessionCommandHandler {
  const owner = useMemo(() => {
    try {
      const saved = channelId
        ? readChannelSessionDraft(scope, channelId, "command")
        : undefined;
      if (saved && saved.viewer !== session.viewer)
        throw new Error("Saved command belongs to another viewer.");
      return {
        saved,
        generation: channelId
          ? readChannelSessionEditorGeneration(
              scope,
              channelId,
              session.viewer,
              "command",
            )
          : 0,
      };
    } catch (reason) {
      return { error: message(reason), generation: 0, saved: undefined };
    }
  }, [session, scope, channelId]);
  const [state, setState] = useState<{
    owner: typeof owner;
    record?: ChannelSessionDraft | undefined;
    error?: string | undefined;
    busy?: boolean;
    generation?: number;
    acceptedId?: string | undefined;
  }>({ owner, record: owner.saved, error: owner.error });
  const current =
    state.owner === owner
      ? state
      : { owner, record: owner.saved, error: owner.error };
  const life = useMemo(
    () => ({
      active: false,
      ready: false,
      generation: owner.generation,
      busy: false,
      record: owner.saved,
      acceptedId: owner.saved?.accepted ? owner.saved.messageId : undefined,
      editor: undefined as ((expected: MentionDraft) => boolean) | undefined,
      command: undefined as
        | {
            lease: SessionCommandLease;
          }
        | undefined,
    }),
    [owner],
  );
  const leaseRef = useRef(lease);
  leaseRef.current = lease;
  const patch = useCallback(
    (next: Partial<typeof state>) => {
      if (life.active)
        setState((previous) => ({
          ...(previous.owner === owner
            ? previous
            : { owner, record: owner.saved, error: owner.error }),
          ...next,
        }));
    },
    [life, owner],
  );
  const lock = useCallback(
    <T,>(work: () => T) =>
      withChannelSessionDraftLock(
        scope,
        channelId ?? "",
        session.viewer,
        work,
        "command",
      ),
    [scope, channelId, session.viewer],
  );
  useLayoutEffect(() => {
    life.active = true;
    return () => {
      life.active = false;
      life.command?.lease.dispose();
      life.command = undefined;
      life.editor = undefined;
    };
  }, [life]);
  useEffect(() => {
    if (!channelId || owner.error) return;
    let active = true;
    void lock(() => {
      if (!active || !life.active) return;
      const saved = readChannelSessionDraft(scope, channelId, "command");
      if (saved) {
        if (saved.viewer !== session.viewer)
          throw new Error("Saved command belongs to another viewer.");
        life.record = saved;
        patch({ record: saved });
      } else {
        if (
          readChannelSessionEditorGeneration(
            scope,
            channelId,
            session.viewer,
            "command",
          ) !== owner.generation
        )
          throw new Error(
            "This command editor is stale. Reopen the channel before starting another session.",
          );
        saveChannelSessionEditorGeneration(
          scope,
          channelId,
          session.viewer,
          owner.generation,
          "command",
        );
      }
      life.ready = true;
    }).catch((reason) => patch({ error: message(reason) }));
    return () => {
      active = false;
    };
    // Scope-local allocation only, never on ordinary editor changes.
  }, [owner, life, channelId, lock, patch, scope, session.viewer]);

  const complete = useCallback(
    async (id: string, saved: ChannelSessionDraft) => {
      if (!life.active || life.record?.id !== saved.id) return;
      life.acceptedId = id;
      patch({ acceptedId: id });
      await lock(() => {
        if (!life.active || life.record?.id !== saved.id) return;
        const command = life.command;
        // A passive rehydrated window may display evidence, not retire another
        // window's intent. Explicit recovery obtains its own current host lease.
        if (!command?.lease.valid() || !life.editor) return;
        const stored = readChannelSessionDraft(
          scope,
          channelId ?? "",
          "command",
        );
        if (!stored || stored.id !== saved.id) return;
        const accepted = { ...stored, messageId: id, accepted: true as const };
        // Preserve acceptance across a crash or a failed editor/storage clear.
        saveChannelSessionDraft(scope, channelId ?? "", accepted, "command");
        life.record = accepted;
        patch({ record: accepted });
        try {
          if (!accepted.rawDraft || !life.editor(accepted.rawDraft))
            throw new Error(
              "The current or saved editor has changed. Keep your text and open the accepted session, or empty the editor before finishing cleanup.",
            );
          life.generation = clearChannelSessionDraft(
            scope,
            channelId ?? "",
            session.viewer,
            "command",
          );
        } catch (reason) {
          patch({
            error: `Session accepted, but local draft cleanup failed: ${message(reason)}`,
          });
          return;
        }
        life.record = undefined;
        life.acceptedId = undefined;
        life.ready = true;
        patch({
          record: undefined,
          acceptedId: undefined,
          error: undefined,
          generation: life.generation,
        });
        if (command.lease.valid()) command.lease.open(id);
        command.lease.dispose();
        life.command = undefined;
      });
    },
    [lock, life, scope, channelId, session.viewer, patch],
  );
  const accepts = useCallback(
    (event: VisibleEvent, saved: ChannelSessionDraft) => {
      if (
        !matchesChannelSessionDraft(
          event,
          saved,
          channelId ?? "",
          session.viewer,
        )
      )
        return false;
      if (event.delivery === "accepted" || event.delivery === "seen")
        return true;
      if (event.delivery !== undefined) return false;
      try {
        eventDto(event);
        return true;
      } catch {
        return false;
      }
    },
    [channelId, session.viewer],
  );
  useEffect(() => {
    const record = current.record;
    if (!record) return;
    let active = true;
    let view: ReturnType<typeof session.observe> | undefined;
    let stop: (() => void) | undefined;
    let looking = false;
    const connect = async () => {
      if (looking || view) return;
      looking = true;
      try {
        const id =
          (await session.outbox?.findDraft(record.id)) ?? record.messageId;
        if (!active || !life.active || life.record?.id !== record.id || !id)
          return;
        // observe includes completed local receipts as well as remote echoes.
        // It does not refresh or allocate a network subscription.
        view = session.observe([{ ids: [id], limit: 1 }]);
        const inspect = () => {
          if (!active || life.record?.id !== record.id) return;
          const accepted = view
            ?.snapshot()
            .events.find((event) => accepts(event, record));
          if (accepted && life.acceptedId !== accepted.id)
            void complete(accepted.id, record).catch((reason) =>
              patch({ error: message(reason) }),
            );
        };
        stop = view.subscribe(inspect);
        inspect();
      } catch (reason) {
        if (active) patch({ error: message(reason) });
      } finally {
        looking = false;
      }
    };
    const watch = () => {
      void connect();
    };
    const stopOutbox = session.outbox?.subscribe(watch);
    watch();
    return () => {
      active = false;
      stopOutbox?.();
      stop?.();
      view?.dispose();
    };
  }, [current.record, session, life, accepts, complete, patch]);
  async function inspect(saved: ChannelSessionDraft) {
    const id = (await session.outbox?.findDraft(saved.id)) ?? saved.messageId;
    if (!life.active || life.record?.id !== saved.id) return;
    const events = await session.read(
      [
        id
          ? { ids: [id], limit: 1 }
          : {
              kinds: [9],
              authors: [session.viewer ?? ""],
              "#h": [channelId ?? ""],
              since: saved.createdAt,
              until: saved.createdAt,
              limit: 200,
            },
      ],
      { fresh: true },
    );
    if (!life.active || life.record?.id !== saved.id) return;
    const accepted = events.find((event) => accepts(event, saved));
    if (accepted) await complete(accepted.id, saved);
    else
      throw new Error(
        "No accepted session was confirmed. Absence is not proof it was never sent; no replacement will be sent.",
      );
  }
  function acquire() {
    const commandLease = leaseRef.current();
    if (!commandLease)
      throw new Error(
        "Sessions is unavailable. Return to Channel and try again.",
      );
    life.command?.lease.dispose();
    life.command = { lease: commandLease };
    return commandLease;
  }
  async function submit(raw: MentionDraft, generation: number) {
    const draft = sessionCommandDraft(raw);
    if (!draft || !channelId || life.busy) return;
    const command = acquire();
    if (!life.ready || owner.error)
      throw new Error(
        owner.error ??
          "This command editor is not ready. Reopen the channel and try again.",
      );
    life.busy = true;
    patch({ busy: true, error: undefined });
    try {
      const claim = await lock(() => {
        if (!life.active || !command.valid())
          throw new Error("Sessions is unavailable. Nothing was sent.");
        const existing = readChannelSessionDraft(scope, channelId, "command");
        if (existing) {
          if (existing.viewer !== session.viewer)
            throw new Error("Saved command belongs to another viewer.");
          life.record = existing;
          patch({ record: existing });
          throw new Error(
            "Recover the saved command before starting another session.",
          );
        }
        if (
          readChannelSessionEditorGeneration(
            scope,
            channelId,
            session.viewer,
            "command",
          ) !== generation ||
          generation !== life.generation
        )
          throw new Error(
            "This command editor is stale. Reopen the channel before starting another session.",
          );
        const recipients = channelSessionRecipients(session, channelId, draft);
        const saved: ChannelSessionDraft = {
          id: crypto.randomUUID(),
          createdAt: Math.floor(Date.now() / 1000),
          draft,
          rawDraft: raw,
          presentation: "chip",
          generation,
          channelId,
          scope,
          viewer: session.viewer ?? "",
        };
        saveChannelSessionDraft(scope, channelId, saved, "command");
        life.record = saved;
        patch({ record: saved });
        return { saved, recipients };
      });
      const { saved, recipients } = claim;
      if (!life.active || !command.valid())
        throw new Error(
          "Session command was interrupted. Check the saved intent; no replacement will be sent.",
        );
      const id = await session.messages.startChannelSession(
        channelId,
        saved.draft.text,
        recipients,
        saved,
        "chip",
      );
      await lock(() => {
        const stored = readChannelSessionDraft(scope, channelId, "command");
        // Acceptance may already have retained or retired this exact intent.
        if (!stored || stored.id !== saved.id) return;
        const updated = { ...stored, messageId: id };
        saveChannelSessionDraft(scope, channelId, updated, "command");
        life.record = updated;
        patch({ record: updated });
      });
    } catch (reason) {
      patch({ error: message(reason) });
    } finally {
      life.busy = false;
      patch({ busy: false });
    }
  }
  async function recover(retry: boolean) {
    if (life.busy || !life.record) return;
    life.busy = true;
    patch({ busy: true, error: undefined });
    try {
      const command = acquire();
      const saved = life.record;
      if (saved.viewer !== session.viewer)
        throw new Error("Saved command belongs to another viewer.");
      if (life.acceptedId || saved.accepted) {
        const acceptedId = life.acceptedId ?? saved.messageId;
        if (!acceptedId)
          throw new Error("The saved accepted session is invalid.");
        await complete(acceptedId, saved);
        return;
      }
      const id = await session.outbox?.findDraft(saved.id);
      if (!life.active || !command.valid())
        throw new Error("Sessions is unavailable.");
      if (retry) {
        const item = session.outbox
          ?.snapshot()
          .find((item) => item.event.id === id);
        if (!item)
          throw new Error(
            "Saved intent is no longer retained. Check the relay; no replacement will be sent.",
          );
        if (
          !matchesChannelSessionDraft(
            item.event,
            saved,
            channelId ?? "",
            session.viewer,
          )
        )
          throw new Error(
            "Saved command conflicts with retained intent. Nothing was resent.",
          );
        if (item.delivery === "failed" || item.delivery === "unknown")
          session.messages.retry(item.event.id);
        else await inspect(saved);
      } else await inspect(saved);
    } catch (reason) {
      patch({ error: message(reason) });
    } finally {
      life.busy = false;
      patch({ busy: false });
    }
  }
  const outboxItems = useSyncExternalStore(
    session.outbox?.subscribe ?? noSubscription,
    session.outbox?.snapshot ?? emptySnapshot,
  );
  const pending =
    !!current.record &&
    outboxItems.some(
      (item) =>
        item.delivery === "sending" &&
        item.event.tags.some(
          ([name, id]) => name === "client-id" && id === current.record?.id,
        ),
    );
  return {
    generation: current.generation ?? owner.generation,
    locked: !!current.busy || pending,
    submit,
    bindEditor(clear) {
      life.editor = clear;
      return () => {
        if (life.editor === clear) life.editor = undefined;
      };
    },
    notice: (
      <>
        {current.record && (
          <section aria-label="Saved session command">
            <p role="status">
              {current.acceptedId || current.record.accepted
                ? "Session accepted. Local draft cleanup still needs review; no replacement will be sent."
                : pending
                  ? "Sending session prompt…"
                  : "Saved session prompt is unconfirmed. Retry keeps the same message."}
            </p>
            {current.acceptedId || current.record.accepted ? (
              <>
                <Button
                  disabled={!!current.busy}
                  onClick={() => void recover(false)}
                >
                  Finish accepted session
                </Button>
                <Button
                  disabled={!!current.busy}
                  onClick={() => {
                    try {
                      const command = acquire();
                      command.open(
                        current.acceptedId ?? current.record?.messageId ?? "",
                      );
                      command.dispose();
                      life.command = undefined;
                    } catch (reason) {
                      patch({ error: message(reason) });
                    }
                  }}
                >
                  Open accepted session
                </Button>
              </>
            ) : (
              <>
                <Button
                  disabled={!!current.busy}
                  onClick={() => void recover(false)}
                >
                  Check saved session
                </Button>
                <Button
                  disabled={!!current.busy}
                  onClick={() => void recover(true)}
                >
                  Retry same prompt
                </Button>
              </>
            )}
          </section>
        )}
        {current.error && <p role="alert">{current.error}</p>}
      </>
    ),
  };
}

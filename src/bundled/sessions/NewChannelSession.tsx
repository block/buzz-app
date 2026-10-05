import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  ChannelThreadDraftProps,
  ConversationExtensions,
} from "../../features/conversation/contracts";
import { MessageComposer } from "../../features/messages/MessageComposer";
import { SessionConversationHeader } from "../../features/messages/SessionConversationHeader";
import conversationStyles from "../../features/messages/SessionConversation.module.css";
import {
  mentionDraft,
  type MentionDraft,
} from "../../features/messages/mention-draft";
import { channelSessionRecipients } from "./channel-session-creation";
import { eventDto } from "../../features/relay/events";
import type { VisibleEvent } from "../../features/relay/projection";
import { Button } from "../../shared/design-system/ui/Button";
import {
  readChannelSessionEditorGeneration,
  saveChannelSessionEditorGeneration,
  withChannelSessionDraftLock,
  matchesChannelSessionDraft,
  channelSessionDraftKey,
  clearChannelSessionDraft,
  readChannelSessionDraft,
  saveChannelSessionDraft,
  type ChannelSessionDraft,
} from "./channel-session-draft";
import { messageViewKey } from "../../features/messages/view-key";
import styles from "./NewChannelSession.module.css";

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

type Props = ChannelThreadDraftProps & {
  extensions?: ConversationExtensions;
};
export function NewChannelSession(props: Props) {
  return (
    <Draft
      key={messageViewKey(props.session, props.scope, props.channelId)}
      {...props}
    />
  );
}
function Draft({
  session,
  scope,
  channelId,
  channelName,
  openThread,
  back,
  extensions,
}: Props) {
  // Observe existing evidence only; selection does not request another inventory.
  useSyncExternalStore(session.profiles.subscribe, session.profiles.snapshot);
  useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
  );
  useSyncExternalStore(session.channels.subscribeList, session.channels.list);
  const canSubmit = (draft: MentionDraft) => {
    try {
      channelSessionRecipients(session, channelId, draft);
      return true;
    } catch {
      return false;
    }
  };
  const [initial] = useState(() => {
    try {
      const record = readChannelSessionDraft(scope, channelId);
      return {
        generation: record
          ? undefined
          : readChannelSessionEditorGeneration(
              scope,
              channelId,
              session.viewer,
            ),
        record,
        error: undefined,
      };
    } catch (reason) {
      return {
        generation: undefined,
        record: undefined,
        error: message(reason),
      };
    }
  });
  const [generationReady, setGenerationReady] = useState(false);
  const [record, setRecord] = useState(initial.record);
  const [error, setError] = useState(initial.error);
  const [busy, setBusy] = useState(false);
  const [eventId, setEventId] = useState<string>();
  const [delivery, setDelivery] = useState("Checking saved intent…");
  const lifetime = useMemo(
    () => ({ active: false, session, scope, channelId, openThread, back }),
    [session, scope, channelId, openThread, back],
  );
  const submitting = useRef(false);
  const completed = useRef(false);
  useLayoutEffect(() => {
    lifetime.active = true;
    return () => {
      lifetime.active = false;
    };
  }, [lifetime]);
  useEffect(() => {
    const generation = initial.generation;
    if (initial.error || initial.record || generation === undefined) return;
    let current = true;
    void withChannelSessionDraftLock(scope, channelId, session.viewer, () => {
      if (!current || !lifetime.active) return false;
      const existing = readChannelSessionDraft(scope, channelId);
      if (existing) {
        setRecord(existing);
        return false;
      }
      if (
        readChannelSessionEditorGeneration(scope, channelId, session.viewer) !==
        initial.generation
      )
        throw new Error(
          "This session editor is stale. Go back and open a new session draft.",
        );
      // Concurrent openings share this generation. Allocation is never a submit action.
      saveChannelSessionEditorGeneration(
        scope,
        channelId,
        session.viewer,
        generation,
      );
      return true;
    })
      .then((ready) => {
        if (current && lifetime.active && ready) setGenerationReady(true);
      })
      .catch((reason) => {
        if (current && lifetime.active) setError(message(reason));
      });
    return () => {
      current = false;
    };
  }, [initial, scope, channelId, session, lifetime]);
  const accepts = useCallback(
    (event: VisibleEvent, saved: ChannelSessionDraft) => {
      if (!matchesChannelSessionDraft(event, saved, channelId, session.viewer))
        return false;
      if (event.delivery === "accepted" || event.delivery === "seen")
        return true;
      // Projected local unsigned/unknown intent is never proof of admission.
      if (event.delivery !== undefined) return false;
      try {
        eventDto(event);
        return true;
      } catch {
        return false;
      }
    },
    [session, channelId],
  );
  const complete = useCallback(
    async (id: string, saved: ChannelSessionDraft) => {
      if (!lifetime.active || completed.current) return;
      try {
        const cleared = await withChannelSessionDraftLock(
          scope,
          channelId,
          session.viewer,
          () => {
            if (!lifetime.active || completed.current) return false;
            // An old acceptance must never clear a newer opening's creation record.
            const current = readChannelSessionDraft(scope, channelId);
            if (current && current.id !== saved.id) return false;
            // Another window may already have cleaned up this accepted intent.
            if (current)
              clearChannelSessionDraft(scope, channelId, session.viewer);
            completed.current = true;
            return true;
          },
        );
        // Acceptance permits cleanup, not navigation: the exact host lease wins.
        if (cleared && lifetime.active) openThread(id);
      } catch (reason) {
        if (lifetime.active)
          setError(
            `Session accepted, but local draft cleanup failed: ${message(reason)}. Check saved session to try again.`,
          );
      }
    },
    [lifetime, openThread, scope, channelId, session],
  );
  useEffect(() => {
    if (!record) return;
    if (!session.outbox) {
      setDelivery(
        "Saved intent is unconfirmed. Outbox recovery is unavailable; check the relay. No replacement will be sent.",
      );
      return;
    }
    let current = true;
    let view: ReturnType<typeof session.observe> | undefined;
    let stop: (() => void) | undefined;
    void session.outbox
      .findDraft(record.id)
      .then((id) => {
        if (!current) return;
        const target = id ?? record.messageId;
        setEventId(id);
        if (!target) {
          setDelivery(
            "Saved intent is uncertain. Check the relay; no replacement will be sent.",
          );
          return;
        }
        view = session.observe([{ ids: [target], limit: 1 }]);
        const inspect = () => {
          if (!current || !view) return;
          const event = view
            .snapshot()
            .events.find((item) => item.id === target);
          if (event && accepts(event, record)) {
            void complete(target, record);
            return;
          }
          setDelivery(
            event?.delivery === "sending"
              ? "Sending session prompt…"
              : (event?.error ??
                  "Saved intent is unconfirmed. Check the relay or explicitly retry the same message."),
          );
        };
        stop = view.subscribe(inspect);
        inspect();
      })
      .catch((reason) => {
        if (current) setError(message(reason));
      });
    return () => {
      current = false;
      stop?.();
      view?.dispose();
    };
    // Commands change with their exact host opening; no automatic refresh or retry.
  }, [record, session, accepts, complete]);

  async function submit(input: MentionDraft) {
    if (
      !generationReady ||
      !lifetime.active ||
      submitting.current ||
      record ||
      initial.error
    )
      return;
    const draft = mentionDraft(input);
    if (!draft.text.trim()) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const claim = await withChannelSessionDraftLock(
        scope,
        channelId,
        session.viewer,
        () => {
          // Lock wait may outlive this opening or the current roster.
          if (!lifetime.active) return;
          const existing = readChannelSessionDraft(scope, channelId);
          if (existing) return { saved: existing, fresh: false as const };
          if (
            readChannelSessionEditorGeneration(
              scope,
              channelId,
              session.viewer,
            ) !== initial.generation
          )
            throw new Error(
              "This session editor is stale. Go back and open a new session draft.",
            );
          const recipients = channelSessionRecipients(
            session,
            channelId,
            draft,
          );
          const saved: ChannelSessionDraft = {
            id: crypto.randomUUID(),
            createdAt: Math.floor(Date.now() / 1000),
            draft,
          };
          saveChannelSessionDraft(scope, channelId, saved);
          return { saved, fresh: true as const, recipients };
        },
      );
      if (!claim || !lifetime.active) return;
      const { saved, fresh } = claim;
      setRecord(saved);
      if (!fresh)
        throw new Error(
          "Recover the saved session prompt before starting another.",
        );
      // The messages owner also rechecks exact membership before committing intent.
      const id = await session.messages.startChannelSession(
        channelId,
        draft.text,
        claim.recipients,
        saved,
      );
      const committed = { ...saved, messageId: id };
      await withChannelSessionDraftLock(
        scope,
        channelId,
        session.viewer,
        () => {
          if (readChannelSessionDraft(scope, channelId)?.id === saved.id)
            saveChannelSessionDraft(scope, channelId, committed);
        },
      );
      if (lifetime.active) {
        setRecord(committed);
        setEventId(id);
      }
    } catch (reason) {
      if (lifetime.active) setError(message(reason));
    } finally {
      submitting.current = false;
      if (lifetime.active) setBusy(false);
    }
  }
  async function check() {
    if (!record || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const id =
        (await session.outbox?.findDraft(record.id)) ?? record.messageId;
      if (!lifetime.active) return;
      const events = await session.read(
        [
          id
            ? { ids: [id], limit: 1 }
            : {
                kinds: [9],
                authors: [session.viewer ?? ""],
                "#h": [channelId],
                since: record.createdAt,
                until: record.createdAt,
                limit: 200,
              },
        ],
        { fresh: true },
      );
      if (!lifetime.active) return;
      const found = events.find((event) => accepts(event, record));
      if (found) await complete(found.id, record);
      else
        setError(
          "No accepted session was confirmed. Keep this draft; absence is not proof it was never sent.",
        );
    } catch (reason) {
      if (lifetime.active) setError(message(reason));
    } finally {
      if (lifetime.active) setBusy(false);
    }
  }
  async function retry() {
    if (!record || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const id = await session.outbox?.findDraft(record.id);
      if (!lifetime.active) return;
      if (!id)
        throw new Error(
          "Saved intent is no longer retained. Check the relay; no replacement will be sent.",
        );
      const item = session.outbox
        ?.snapshot()
        .find((item) => item.event.id === id);
      if (
        item &&
        !matchesChannelSessionDraft(
          item.event,
          record,
          channelId,
          session.viewer,
        )
      )
        throw new Error(
          "Saved draft inputs conflict with the retained intent. Nothing was resent.",
        );
      if (item?.delivery === "failed" || item?.delivery === "unknown")
        session.messages.retry(id);
      else if (item?.delivery === "accepted" || !item) await check();
    } catch (reason) {
      if (lifetime.active) setError(message(reason));
    } finally {
      if (lifetime.active) setBusy(false);
    }
  }
  return (
    <section
      className={`${styles.draft} ${conversationStyles.conversation}`}
      aria-label="New channel session"
    >
      <SessionConversationHeader title="New session" back={back} />
      <div className={styles.blank}>
        <p>Start conversation</p>
      </div>
      <div className={styles.guidance}>
        <p className={styles.hint}>
          Select an agent with @ to start. Visible to everyone in #{channelName}
          .
        </p>
        {record && (
          <div role="status">
            <p>{delivery}</p>
            <Button disabled={busy} onClick={() => void check()}>
              Check saved session
            </Button>
            {eventId && (
              <Button disabled={busy} onClick={() => void retry()}>
                Retry same prompt
              </Button>
            )}
          </div>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
      <MessageComposer
        session={session}
        scope={scope}
        channelId={channelId}
        channelName={channelName}
        extensions={extensions}
        label="Message this session"
        submission={{
          draftKey: channelSessionDraftKey(channelId),
          canSubmit,
          initialDraft: record?.draft,
          locked: busy || !!record || !!initial.error,
          disabled: !generationReady || busy || !!record || !!initial.error,
          submit: (draft) => {
            void submit(draft);
          },
        }}
      />
    </section>
  );
}

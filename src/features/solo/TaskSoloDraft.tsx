import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../relay/session";
import type { ConversationExtensions } from "../conversation/contracts";
import type { TaskDraft } from "../channel-navigation/solo-navigation-contract";
import { soloNavigationFor } from "../channel-navigation/solo-navigation";
import {
  taskDraftContext,
  TASK_MODE_LABEL,
  TASK_UNAVAILABLE,
  taskFirstEventRecovery,
  readTaskFirstEventRecovery,
  validateTaskPublication,
  validateTaskMembers,
  recordTaskFirstEvent,
  acknowledgeTaskFirstEvent,
} from "./task-mode";
import { SoloDraftView } from "./SoloPresentation";
import { MessageComposer } from "../messages/MessageComposer";
import {
  mentionDraft,
  hasDraftContent,
  type MentionDraft,
} from "../messages/mention-draft";
import {
  attachmentDraft,
  transferAttachmentDraft,
  type AttachmentDraft,
} from "../messages/attachment-draft";
import { composerMarkdown } from "../messages/composer-markdown";
import {
  readView,
  writeView,
  viewRevision,
  replaceView,
} from "../../shared/view-state";
import { attachmentMessage } from "../relay/attachments";
import { startingChatTitle } from "./chat-title";
import type { SoloDraft as DraftRoute } from "../channel-navigation/routes";
import { ChatNotStarted } from "../relay/channel-writes";
import { taskHeaderUI } from "./TaskHeaderTitle";
import { regionLabels } from "./region-labels";
import composerStyles from "../messages/Messages.module.css";

const noopSubscribe = () => () => {};
const noSnapshot = () => undefined;

/** Task-only preparation reuses the host editor and Solo start. Workspace
 * defaults never enter this path. The plugin owns the durable creation intent. */
export function TaskSoloDraft({
  session,
  scope,
  route,
  agent,
  extensions,
  onStarted,
  onFailed,
  focusRequest,
}: {
  session: RelaySession;
  scope: string;
  route: NonNullable<DraftRoute["task"]>;
  agent?: string | undefined;
  extensions?: ConversationExtensions | undefined;
  onStarted(id: string): void;
  onFailed?: ((id: string, reason: string) => void) | undefined;
  focusRequest?: number | AbortSignal;
}) {
  const service = soloNavigationFor(session);
  useSyncExternalStore(
    service?.subscribe ?? noopSubscribe,
    service?.snapshot ?? noSnapshot,
  );
  const choices = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
  );
  const context = taskDraftContext(session, route.region);
  const key = `solo:task:${route.draftId}`;
  const [state, setState] = useState(() => {
    const identity = readView<{ revision?: number; primary?: string | null }>(
      scope,
      `${key}:identity`,
      {},
    );
    return {
      draft: mentionDraft(readView(scope, `${key}:new-draft`, "")),
      revision: Number.isSafeInteger(identity?.revision)
        ? (identity.revision ?? 0)
        : 0,
      primary:
        identity?.primary === null ? undefined : (identity?.primary ?? agent),
    };
  });
  const current = useRef(state);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const attempt = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => attempt.current?.abort(), []);
  const changed = useCallback(
    (draft: MentionDraft) => {
      const previous = current.current;
      let primary = previous.primary;
      if (
        (draft.recipients.length || previous.draft.recipients.length) &&
        !draft.recipients.some((item) => item.pubkey === primary)
      )
        primary = draft.recipients[0]?.pubkey;
      if (
        JSON.stringify(draft) === JSON.stringify(previous.draft) &&
        primary === previous.primary
      )
        return;
      const next = { draft, primary, revision: previous.revision + 1 };
      if (
        !writeView(scope, `${key}:identity`, {
          revision: next.revision,
          primary: primary ?? null,
        })
      )
        throw new Error("The task draft could not be saved. Try again.");
      current.current = next;
      setState(next);
    },
    [scope, key],
  );
  const eligiblePrimary = (() => {
    try {
      return context &&
        state.primary &&
        context.mode.participants.eligible(state.primary)
        ? choices.selectable.find((item) => item.pubkey === state.primary)
        : undefined;
    } catch {
      return undefined;
    }
  })();
  const snapshot = (
    draft: MentionDraft,
    attachments: TaskDraft["attachments"] = [],
  ): TaskDraft | undefined =>
    context
      ? {
          draftId: route.draftId,
          revision: current.current.revision,
          binding: context.binding,
          text: composerMarkdown(draft),
          recipients: [...new Set(draft.recipients.map((item) => item.pubkey))],
          ...(current.current.primary
            ? { primary: current.current.primary }
            : {}),
          ...(draft.workspace ? { workspace: draft.workspace } : {}),
          attachments,
        }
      : undefined;
  async function start(draft: MentionDraft, files: AttachmentDraft) {
    if (attempt.current || !context) return;
    const currentContext = context;
    const outbox = session.outbox;
    const controller = new AbortController();
    attempt.current = controller;
    setBusy(true);
    setError(undefined);
    const signal = AbortSignal.any([controller.signal, currentContext.signal]);
    try {
      if (!outbox) throw new Error("Task messaging is unavailable.");
      await outbox.ready();
      signal.throwIfAborted();
      const journal = outbox;
      await journal.withChat(`solo-task:${route.draftId}`, async (owned) => {
        async function resumeSaved() {
          const operations = journal.snapshot();
          const pending = operations.filter(
            (item) => item.recovery?.key === `solo-task:${route.draftId}`,
          );
          if (pending.length > 1)
            throw new Error(
              "More than one saved first message needs review in Outbox.",
            );
          const saved = pending[0];
          if (saved?.recovery) {
            const recovery = readTaskFirstEventRecovery(
              saved.event,
              saved.recovery,
            );
            if (
              saved.event.pubkey !== session.viewer ||
              recovery.draftId !== route.draftId ||
              recovery.regionLabel !== currentContext.label
            )
              throw new Error(
                "The saved task message does not match this draft.",
              );
            const creates = operations.filter(
              (item) =>
                item.event.kind === 9007 &&
                item.event.tags.some(
                  ([key, value]) => key === "h" && value === recovery.channelId,
                ),
            );
            if (creates.length > 1)
              throw new Error(
                "More than one saved task creation needs review in Outbox.",
              );
            const create = creates[0];
            const members =
              create?.event.tags
                .filter(([key]) => key === "p")
                .map((tag) => tag[1] ?? "") ?? [];
            const recipients = saved.event.tags
              .filter(([key]) => key === "p")
              .map((tag) => tag[1] ?? "");
            const active = () => {
              try {
                return (
                  owned() &&
                  !signal.aborted &&
                  !currentContext.signal.aborted &&
                  taskDraftContext(session, currentContext.label)?.binding
                    .incarnation === currentContext.binding.incarnation &&
                  recipients.length > 0 &&
                  recipients.length <=
                    (currentContext.mode.participants.maxRecipients ?? 1) &&
                  [...members, ...recipients].every(
                    (key) =>
                      key === session.viewer ||
                      currentContext.mode.participants.eligible(key),
                  )
                );
              } catch {
                return false;
              }
            };
            if (!active())
              throw new Error(
                "A saved task participant is no longer eligible.",
              );
            const targetKey = `draft:${recovery.channelId}`;
            const targetRevision = viewRevision(scope, targetKey);
            const target = mentionDraft(readView(scope, targetKey, ""));
            const content = composerMarkdown(draft);
            const retained = files.snapshot();
            const uploaded = retained.flatMap((item) =>
              item.uploaded ? [item.uploaded] : [],
            );
            let outgoing: ReturnType<typeof attachmentMessage> | undefined;
            if (uploaded.length === retained.length) {
              try {
                outgoing = attachmentMessage(
                  content,
                  uploaded,
                  uploaded[0]?.url,
                );
              } catch {
                /* Changed/invalid files remain editable; never re-upload recovery. */
              }
            }
            const edited =
              !outgoing ||
              outgoing.content !== saved.event.content ||
              JSON.stringify(outgoing.tags) !==
                JSON.stringify(
                  saved.event.tags.filter(([name]) => name === "imeta"),
                ) ||
              JSON.stringify(
                [
                  ...new Set(draft.recipients.map((item) => item.pubkey)),
                ].sort(),
              ) !== JSON.stringify([...new Set(recipients)].sort());
            const targetFiles = attachmentDraft(
              session,
              `${scope}:${targetKey}`,
              recovery.channelId,
            );
            if (
              edited &&
              hasDraftContent(target, targetFiles.snapshot().length)
            )
              throw new Error(
                "This task already has a draft. Your changes remain here; open the task to review its existing draft first.",
              );
            if (create) {
              const labels = create.event.tags
                .filter(([key]) => key === "t")
                .map((tag) => tag[1] ?? "");
              if (
                !labels.includes(TASK_MODE_LABEL) ||
                JSON.stringify(regionLabels(labels)) !==
                  JSON.stringify([currentContext.label]) ||
                recipients.some((key) => !members.includes(key))
              )
                throw new Error(
                  "The saved task creation does not match this message.",
                );
              if (create?.recovery?.key === `create:${saved.recovery.key}`) {
                if (create.recovery.value !== saved.recovery.value)
                  throw new Error("The saved task pair does not match.");
                const claim = await currentContext.mode.markChannelStarted(
                  {
                    draftId: recovery.draftId,
                    revision: recovery.revision,
                    preparationId: recovery.preparationId,
                    channelId: recovery.channelId,
                    binding: currentContext.binding,
                  },
                  signal,
                );
                signal.throwIfAborted();
                if (claim !== "start" && claim !== "resume")
                  throw new Error("The saved task claim is invalid.");
              }
              const resumed = session.channelWrites.resumeStart(
                create.event.id,
                recovery.channelId,
                session.viewer,
                active,
              );
              void resumed.ready.catch((reason: unknown) => {
                if (reason instanceof ChatNotStarted)
                  onFailed?.(recovery.channelId, reason.message);
              });
            }
            validateTaskPublication(session, saved.event);
            if (saved.delivery === "accepted" || saved.delivery === "seen") {
              if (!saved.signed)
                throw new Error(
                  "Reload to inspect the saved task receipt before finishing.",
                );
              await recordTaskFirstEvent(
                session,
                saved.signed,
                saved.recovery,
                signal,
              );
            } else {
              await journal.resume(saved.event.id, active);
            }
            await acknowledgeTaskFirstEvent(journal, saved.event.id);
            signal.throwIfAborted();
            if (edited) {
              if (
                replaceView(scope, targetKey, targetRevision, draft) !== "saved"
              )
                throw new Error(
                  "The task draft changed. Your changes remain here; retry after reviewing the task.",
                );
              if (files.snapshot().length)
                transferAttachmentDraft(files, targetFiles);
              writeView(scope, `${key}:new-draft`, "");
            }
            if (!edited) {
              files.clear();
              writeView(scope, `${key}:new-draft`, "");
            }
            onStarted(recovery.channelId);
            return true;
          }
          return false;
        }
        if (await resumeSaved()) return;
        const recipients = [
          ...new Set(draft.recipients.map((item) => item.pubkey)),
        ];
        if (
          recipients.length >
          (currentContext.mode.participants.maxRecipients ?? 1)
        )
          throw new Error("Tag one agent per message");
        changed(draft);
        const uploaded = await files.prepareForSend(signal);
        signal.throwIfAborted();
        const input = snapshot(draft, uploaded);
        if (
          !input?.primary ||
          !input.recipients.includes(input.primary) ||
          input.recipients.some(
            (key) => !currentContext.mode.participants.eligible(key),
          )
        )
          throw new Error("Choose an eligible primary agent before sending.");
        const message = session.messages.prepareNewChat(
          input.text,
          [input.primary],
          uploaded,
        );
        if (message.content.length > 32_000)
          throw new Error("The task message exceeds 32,000 characters.");
        const result = await currentContext.mode.prepare(input, signal);
        signal.throwIfAborted();
        if (!result.ok) {
          if (result.reason === "already_sent" && result.channelId) {
            const channelId = result.channelId;
            const targetKey = `draft:${channelId}`;
            const targetRevision = viewRevision(scope, targetKey);
            const targetFiles = attachmentDraft(
              session,
              `${scope}:${targetKey}`,
              channelId,
            );
            await session.channelWrites.refresh(channelId);
            signal.throwIfAborted();
            const current = taskDraftContext(session, currentContext.label);
            const target = validateTaskMembers(session, channelId);
            signal.throwIfAborted();
            if (
              !current ||
              !target ||
              target.label !== currentContext.label ||
              current.binding.scope !== currentContext.binding.scope ||
              current.binding.viewer !== session.viewer ||
              current.binding.viewer !== currentContext.binding.viewer ||
              current.binding.incarnation !==
                currentContext.binding.incarnation ||
              target.binding.scope !== current.binding.scope ||
              target.binding.viewer !== current.binding.viewer ||
              target.binding.incarnation !== current.binding.incarnation
            )
              throw new Error(
                "The completed task no longer belongs to this draft.",
              );
            if (
              hasDraftContent(
                mentionDraft(readView(scope, targetKey, "")),
                targetFiles.snapshot().length,
              )
            )
              throw new Error(
                "This task already has a draft. Your changes remain here; open the task to review its existing draft first.",
              );
            if (
              replaceView(scope, targetKey, targetRevision, draft) !== "saved"
            )
              throw new Error(
                "The task draft changed. Your changes remain here; retry after reviewing the task.",
              );
            if (files.snapshot().length)
              transferAttachmentDraft(files, targetFiles);
            writeView(scope, `${key}:new-draft`, "");
            onStarted(channelId);
            return;
          }
          throw new Error(
            result.reason === "already_sent"
              ? "Finish creating this task after reloading. Your draft and files are kept here."
              : result.reason,
          );
        }
        if (!Array.isArray(result.members))
          throw new Error("The prepared task has invalid participants.");
        const prepared = Object.freeze({
          ...result,
          members: Object.freeze([...result.members]),
        });
        if (
          !prepared.channelId ||
          !prepared.preparationId ||
          prepared.revision !== input.revision ||
          !prepared.members.includes(input.primary) ||
          input.recipients.some((key) => !prepared.members.includes(key)) ||
          prepared.members.some(
            (key) =>
              key !== session.viewer &&
              (!input.recipients.includes(key) ||
                !currentContext.mode.participants.eligible(key)),
          )
        )
          throw new Error(
            "The prepared task has changed. Review its agents and retry.",
          );
        const create = session.channelWrites.prepareStart(
          prepared.channelId,
          prepared.title || startingChatTitle(draft),
          undefined,
          false,
          prepared.members,
          [currentContext.label, TASK_MODE_LABEL],
        );
        await message.stage(
          create,
          taskFirstEventRecovery({
            draftId: input.draftId,
            revision: input.revision,
            preparationId: prepared.preparationId,
            channelId: prepared.channelId,
            regionLabel: currentContext.label,
          }),
        );
        signal.throwIfAborted();
        if (!(await resumeSaved()))
          throw new Error("The saved task submission is unavailable.");
      });
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (attempt.current === controller) attempt.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const Header = context?.mode.header;
  return (
    <SoloDraftView>
      <MessageComposer
        session={session}
        scope={scope}
        channelId={route.draftId}
        channelName="this task"
        extensions={extensions}
        chatPresentation
        ownSoloConversation
        inviteAgents
        label="Message your task agent"
        placeholder="What do you want to accomplish?"
        autoFocus={!!focusRequest}
        defaultMention={eligiblePrimary}
        requireMention
        taskDraft={{
          region:
            context?.region ??
            route.region.slice(route.region.lastIndexOf(":") + 1),
          policy: context?.mode.participants,
        }}
        submission={{
          draftKey: `${key}:new-draft`,
          locked: busy,
          disabled: busy || !context || !session.channelWrites.available,
          attachments: true,
          changed,
          header: (draft, controls) => {
            const input = snapshot(draft);
            return Header && input ? (
              <Header draft={input} {...controls} ui={taskHeaderUI} />
            ) : null;
          },
          submit: (draft, files) => {
            void start(draft, files);
          },
        }}
      />
      {!context && (
        <p className={composerStyles.composerColumn} role="status">
          {TASK_UNAVAILABLE}
        </p>
      )}
      {eligiblePrimary && (
        <p className={composerStyles.composerColumn}>
          Primary: {eligiblePrimary.name}
        </p>
      )}
      {error && (
        <p className={composerStyles.composerColumn} role="alert">
          {error}
        </p>
      )}
    </SoloDraftView>
  );
}

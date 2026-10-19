import {
  canonicalDetailsName,
  detailsDraftErrors,
} from "../relay/channel-details-protocol";
import { startingChatTitle } from "./chat-title";
import { withdraw } from "./withdraw";
import { ChatNotStarted } from "../relay/channel-writes";
import { DraftSettings } from "./DraftSettings";
import { SoloDraftView } from "./SoloPresentation";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { GearIcon } from "../../shared/design-system/icons";
import { applyChatSetup, loadChatSetup, parseChatSetup } from "./workspace";
import { useEffect, useRef, useState } from "react";
import type { RelaySession } from "../relay/session";
import {
  readView,
  writeView,
  subscribeView,
  viewRevision,
} from "../../shared/view-state";
import { MessageComposer } from "../messages/MessageComposer";
import { useDefaultAgent } from "./default-agent";
import { WorkspaceControl } from "./WorkspaceControl";
import { rememberedMentions } from "../messages/remembered-mentions";
import { composerMarkdown } from "../messages/composer-markdown";
import { mentionDraft, type MentionDraft } from "../messages/mention-draft";
import type { ComposerInputElement } from "../messages/composer-dom";
import {
  attachmentDraft,
  transferAttachmentDraft,
  type AttachmentDraft,
} from "../messages/attachment-draft";
import type { ConversationExtensions } from "../conversation/contracts";
import styles from "./Solo.module.css";

/** Starting a new chat from a project starts it in that project, even when an
 * earlier draft there was switched to another one. */
function readDraftSettings(scope: string, draftKey: string) {
  const saved = readView<unknown>(scope, `${draftKey}:settings`, null);
  const settings = saved && typeof saved === "object" ? saved : {};
  return {
    name: "name" in settings ? (settings.name as string) : "",
    canvas:
      "canvas" in settings && typeof settings.canvas === "string"
        ? settings.canvas
        : undefined,
    // Preserve malformed lifetime input for the existing visible validation.
    ttlSeconds: ("ttlSeconds" in settings ? settings.ttlSeconds : undefined) as
      | number
      | undefined,
  };
}

/** Whether a saved draft holds nothing typed: the composer's automatic agent
 * tag alone counts as empty. */
function blankDraft(saved: unknown) {
  const { text, recipients } = mentionDraft(saved);
  let rest = text;
  for (const { start, end } of [...recipients].sort(
    (a, b) => b.start - a.start,
  ))
    rest = rest.slice(0, start) + rest.slice(end);
  return !rest.trim();
}

/** One draft holding `drafts` in order, a blank line apart, tags kept. */
function joinDrafts(...drafts: readonly MentionDraft[]): MentionDraft {
  let text = "";
  const recipients: MentionDraft["recipients"][number][] = [];
  const sessionCards: string[] = [];
  for (const draft of drafts) {
    if (blankDraft(draft)) continue;
    if (text) text = `${text.trimEnd()}\n\n`;
    const offset = text.length;
    text += draft.text;
    for (const item of draft.recipients)
      recipients.push({
        ...item,
        start: item.start + offset,
        end: item.end + offset,
      });
    sessionCards.push(...(draft.sessionCards ?? []));
  }
  return {
    text,
    recipients,
    ...(sessionCards.length
      ? { sessionCards: [...new Set(sessionCards)] }
      : {}),
  };
}

export function resetNewChatProject(scope: string, projectId: string) {
  const key = `solo:project:${projectId}`;
  const selected = readView<unknown>(scope, `${key}:new-project`, projectId);
  // Instructions belong to the previous project; name and lifetime stay.
  if (selected !== projectId)
    writeView(scope, `${key}:settings`, {
      ...readDraftSettings(scope, key),
      canvas: undefined,
    });
  writeView(scope, `${key}:new-project`, null);
}

export function SoloDraft({
  session,
  scope,
  onStarted,
  onFailed,
  projectId,
  extensions,
  focusRequest = 0,
  agent,
}: {
  /** Start with this agent chosen, as when search opens a new chat with it. */
  agent?: string | undefined;
  focusRequest?: number | AbortSignal;
  extensions?: ConversationExtensions | undefined;
  session: RelaySession;
  scope: string;
  onStarted: (id: string) => void;
  /** The started chat `id` could not be made; its draft is back here. */
  onFailed?: ((id: string) => void) | undefined;
  projectId?: string | undefined;
}) {
  const draftKey = projectId ? `solo:project:${projectId}` : "solo";
  const [settingsOpen, setSettingsOpen] = useState(false);
  // New chats tag their agent in the draft: the one the route names, else the
  // default.
  const defaultAgent = useDefaultAgent(session, scope, agent);
  const [selectedProject, setSelectedProject] = useState(() => {
    const saved = readView<unknown>(
      scope,
      `${draftKey}:new-project`,
      projectId ?? "",
    );
    return typeof saved === "string" ? saved : (projectId ?? "");
  });
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const [draftSettings, setDraftSettings] = useState(() =>
    readDraftSettings(scope, draftKey),
  );
  const draftCanvas = draftSettings.canvas;
  // Project entry can reset this draft while the composer stays mounted.
  // Observe only changed revisions so unrelated writes don't discard local edits
  // when ordinary view persistence is unavailable.
  useEffect(() => {
    const projectKey = `${draftKey}:new-project`;
    const settingsKey = `${draftKey}:settings`;
    let projectRevision = viewRevision(scope, projectKey);
    let settingsRevision = viewRevision(scope, settingsKey);
    return subscribeView(scope, () => {
      const nextProject = viewRevision(scope, projectKey);
      const nextSettings = viewRevision(scope, settingsKey);
      if (nextProject !== undefined && nextProject !== projectRevision) {
        projectRevision = nextProject;
        const project = readView<unknown>(scope, projectKey, projectId ?? "");
        setSelectedProject(
          typeof project === "string" ? project : (projectId ?? ""),
        );
      }
      if (nextSettings !== undefined && nextSettings !== settingsRevision) {
        settingsRevision = nextSettings;
        setDraftSettings(readDraftSettings(scope, draftKey));
      }
    });
  }, [scope, draftKey, projectId]);
  const prompt = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusRequest) return;
    const input = prompt.current?.querySelector<
      HTMLTextAreaElement | ComposerInputElement
    >('textarea, [contenteditable="true"]');
    input?.focus();
    // A returning draft resumes at its end, not before its first tag.
    input?.setSelectionRange(input.value.length, input.value.length);
  }, [focusRequest]);
  const available = session.channelWrites.available;
  const [channelId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  // A start that failed after leaving this view comes back with its reason.
  const [error, setError] = useState<string | undefined>(() => {
    const saved = readView<unknown>(scope, `${draftKey}:start-error`, null);
    return typeof saved === "string" ? saved : undefined;
  });
  useEffect(() => {
    writeView(scope, `${draftKey}:start-error`, null);
  }, [scope, draftKey]);
  const submitting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function start(draft: MentionDraft, files: AttachmentDraft) {
    const text = composerMarkdown(draft);
    if (submitting.current || !text.trim() || !available) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    const recipients = [
      ...new Set(mentionDraft(draft).recipients.map((item) => item.pubkey)),
    ];
    const named =
      typeof draftSettings.name === "string" &&
      !!canonicalDetailsName(draftSettings.name);
    const name =
      typeof draftSettings.name === "string"
        ? canonicalDetailsName(draftSettings.name) || startingChatTitle(draft)
        : draftSettings.name;
    const { ttlSeconds } = draftSettings;
    const project = selectedProject;
    const canvas = draftCanvas;
    try {
      if (typeof name !== "string")
        throw new Error("The chat name could not be verified.");
      const errors = detailsDraftErrors({
        name,
        description: "",
        visibility: "private",
        ttlSeconds,
      });
      if (errors.name) throw new Error(errors.name);
      if (errors.lifetime) throw new Error(errors.lifetime);
      // The agents already listed decide at once; only an unknown one waits
      // for a fresh list.
      const selectable = () =>
        recipients.every((key) =>
          session.agentChoices
            .snapshot()
            .selectable.some((agent) => agent.pubkey === key),
        );
      if (!selectable()) {
        await session.agentChoices.refresh();
        if (!mounted.current) return;
        if (!selectable())
          throw new Error(
            "Solo chats can only use your available agents. Check mentions.",
          );
      }
      // Finish uploads before anything is created, so a failed file blocks
      // the start instead of leaving an empty chat behind.
      const uploaded = await files.prepareForSend(new AbortController().signal);
      if (!mounted.current) return;
      const kept = files.snapshot();
      // A workspace's defaults load while the chat is created; its Canvas and
      // placement go in once the chat exists, before the first turn reads them.
      const setup =
        project || canvas !== undefined
          ? (async () => {
              let setup = project
                ? await loadChatSetup(session, project)
                : undefined;
              if (canvas !== undefined)
                setup = parseChatSetup({
                  ...(setup ?? {
                    ...(project ? { projectId: project } : {}),
                    agents: [],
                  }),
                  canvas,
                });
              return setup;
            })()
          : undefined;
      setup?.catch(() => {});
      // The chat lists at once and its message goes out behind the create,
      // so the agents start on it without waiting for the relay.
      const { create, ready } = session.channelWrites.start(
        channelId,
        name,
        recipients,
        ttlSeconds,
        named,
        setup &&
          (async () => {
            const loaded = await setup;
            if (loaded)
              await applyChatSetup(session, channelId, loaded, () => true);
          }),
      );
      let message: string | undefined;
      try {
        message = session.messages.send(
          channelId,
          text,
          recipients,
          ...(uploaded.length ? [uploaded] : []),
        );
        files.clear();
        writeView(
          scope,
          `draft:${channelId}`,
          rememberedMentions(session, draft, recipients),
        );
      } catch (reason) {
        // The chat still starts; its own composer keeps the message to send.
        console.warn("Solo first message waits in its chat", reason);
        writeView(scope, `draft:${channelId}`, draft);
        transferAttachmentDraft(
          files,
          attachmentDraft(session, `${scope}:draft:${channelId}`, channelId),
        );
      }
      writeView(scope, `${draftKey}:settings`, null);
      writeView(scope, `${draftKey}:new-draft`, "");
      writeView(scope, `${draftKey}:new-project`, null);
      onStarted(channelId);
      void ready.catch(async (reason: unknown) => {
        // Only a start that made no chat comes back here; any other miss
        // leaves the chat listed, with its messages' own Retry.
        if (!(reason instanceof ChatNotStarted)) return;
        const outbox = session.outbox;
        // Everything sent in the pending chat was held for it: withdraw it all
        // and keep the text of what came after the first message.
        const held = (outbox?.snapshot() ?? []).filter(
          (item) =>
            item.event.id !== create &&
            item.event.tags.some(
              ([tag, value]) => tag === "h" && value === channelId,
            ),
        );
        await Promise.all([
          ...held.map((item) =>
            outbox
              ? withdraw(outbox, item.event.id).catch(() => {})
              : undefined,
          ),
          session.channelWrites.failed(create) &&
            session.channelWrites.discardFailed(create).catch(() => {}),
        ]);
        const followUps = held
          .filter((item) => item.event.id !== message && item.event.kind === 9)
          .map((item) => mentionDraft(item.event.content));
        // So does anything typed there and not yet sent, files included.
        const unsent = mentionDraft(
          readView<unknown>(scope, `draft:${channelId}`, null),
        );
        writeView(scope, `draft:${channelId}`, null);
        const chatFiles = attachmentDraft(
          session,
          `${scope}:draft:${channelId}`,
          channelId,
        );
        const restored = joinDrafts(draft, ...followUps, unsent);
        // Put the start back in the new-chat composer. A newer draft there
        // keeps its settings and takes the start after its own text.
        const current = readView<unknown>(scope, `${draftKey}:new-draft`, "");
        if (blankDraft(current)) {
          writeView(scope, `${draftKey}:new-draft`, restored);
          writeView(scope, `${draftKey}:settings`, {
            name: draftSettings.name,
            canvas,
            ttlSeconds,
          });
          writeView(scope, `${draftKey}:new-project`, project || null);
        } else
          writeView(
            scope,
            `${draftKey}:new-draft`,
            joinDrafts(mentionDraft(current), restored),
          );
        const chatKept = chatFiles.snapshot();
        if (files.adopt([...kept, ...chatKept]) && chatKept.length)
          chatFiles.clear();
        writeView(scope, `${draftKey}:start-error`, reason.message);
        onFailed?.(channelId);
      });
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const composer = (
    <div id="new-session-prompt" ref={prompt}>
      <MessageComposer
        chatPresentation
        ownSoloConversation
        session={session}
        extensions={extensions}
        scope={scope}
        channelId={channelId}
        channelName="this chat"
        label="Message your agents"
        inviteAgents
        defaultMention={defaultAgent}
        requireMention
        trailingTool={
          session.soloPreferences ? (
            <WorkspaceControl
              session={session}
              value={selectedProject}
              onChange={(project) => {
                if (project === selectedProject) return;
                setSelectedProject(project);
                writeView(scope, `${draftKey}:new-project`, project);
                const next = {
                  name: draftSettings.name,
                  ttlSeconds: draftSettings.ttlSeconds,
                  canvas: undefined,
                };
                setDraftSettings(next);
                writeView(scope, `${draftKey}:settings`, next);
              }}
              disabled={busy}
            />
          ) : undefined
        }
        submission={{
          draftKey: `${draftKey}:new-draft`,
          locked: busy,
          disabled: busy || !available,
          attachments: true,
          submit: (draft, files) => {
            void start(draft, files);
          },
        }}
      />
      {!available && (
        <p className={styles.availability} role="status">
          Solo preferences or channel creation are unavailable. Your draft is
          saved.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
  return (
    <SoloDraftView
      actions={
        <IconButton
          ref={settingsTrigger}
          size="toolbar"
          aria-label="Chat settings"
          title="Chat settings"
          icon={<GearIcon size="1rem" aria-hidden="true" />}
          disabled={busy}
          onClick={() => setSettingsOpen(true)}
        />
      }
    >
      {composer}
      {settingsOpen && (
        <DraftSettings
          finalFocus={settingsTrigger}
          session={session}
          projectId={selectedProject || undefined}
          canvas={draftCanvas}
          name={draftSettings.name}
          ttlSeconds={draftSettings.ttlSeconds}
          close={() => setSettingsOpen(false)}
          save={(canvas, ttlSeconds, name) => {
            const next = { canvas, ttlSeconds, name: name ?? "" };
            if (!writeView(scope, `${draftKey}:settings`, next))
              throw new Error(
                "Settings couldn’t be saved on this device. Try again.",
              );
            setDraftSettings(next);
          }}
        />
      )}
    </SoloDraftView>
  );
}

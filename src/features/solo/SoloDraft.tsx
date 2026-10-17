import {
  canonicalDetailsName,
  detailsDraftErrors,
} from "../relay/channel-details-protocol";
import { startingChatTitle } from "./chat-title";
import { readPending, type PendingStart } from "./pending-start";
import { DraftSettings } from "./DraftSettings";
import { SoloDraftView } from "./SoloPresentation";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { GearIcon } from "../../shared/design-system/icons";
import {
  applySessionSetup,
  removedSectionMessage,
  loadSessionSetup,
  parseSessionSetup,
} from "./workspace";
import { Button } from "../../shared/design-system/ui/Button";
import { useEffect, useRef, useState } from "react";
import type { RelaySession } from "../relay/session";
import {
  readView,
  writeView,
  replaceView,
  subscribeView,
  viewRevision,
} from "../../shared/view-state";
import { MessageComposer } from "../messages/MessageComposer";
import { useDefaultAgent } from "./default-agent";
import { ProjectControl } from "./ProjectControl";
import { legacyAssistantDraft } from "./legacy-assistant";
import { rememberedMentions } from "../messages/remembered-mentions";
import { composerMarkdown } from "../messages/composer-markdown";
import { mentionDraft, type MentionDraft } from "../messages/mention-draft";
import type { ConversationExtensions } from "../conversation/contracts";
import styles from "./Solo.module.css";

/** Starting a new chat from a project starts it in that project, even when an
 * earlier draft there was switched to another one. */
function readDraftSettings(scope: string, draftKey: string) {
  const saved = readView<unknown>(scope, `${draftKey}:settings`, null);
  if (typeof saved === "string") return { canvas: saved, name: "" };
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

export function resetNewChatProject(scope: string, sectionId: string) {
  const key = `me:section:${sectionId}`;
  // A submitted start owns its frozen project and must remain recoverable.
  if (readPending(scope, key)) return;
  const selected = readView<unknown>(scope, `${key}:new-project`, sectionId);
  // Instructions belong to the previous project; name and lifetime stay.
  if (selected !== sectionId)
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
  sectionId,
  extensions,
  standalone = false,
  focusRequest = 0,
  resumeDraftKey,
  agent,
}: {
  /** Start with this agent chosen, as when search opens a new session with it. */
  agent?: string | undefined;
  resumeDraftKey?: string | undefined;
  standalone?: boolean;
  focusRequest?: number | AbortSignal;
  extensions?: ConversationExtensions | undefined;
  session: RelaySession;
  scope: string;
  onStarted: (id: string) => void;
  sectionId?: string | undefined;
}) {
  const draftKey =
    resumeDraftKey ?? (sectionId ? `me:section:${sectionId}` : "me");
  const [settingsOpen, setSettingsOpen] = useState(false);
  // New chats tag their agent in the draft: the one the route names, else the
  // default. An interrupted start keeps the assistant its receipt was
  // admitted with.
  const defaultAgent = useDefaultAgent(session, scope, agent);
  const [selectedProject, setSelectedProject] = useState(() => {
    const saved = readView<unknown>(
      scope,
      `${draftKey}:new-project`,
      sectionId ?? "",
    );
    return typeof saved === "string" ? saved : (sectionId ?? "");
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
        const project = readView<unknown>(scope, projectKey, sectionId ?? "");
        setSelectedProject(
          typeof project === "string" ? project : (sectionId ?? ""),
        );
      }
      if (nextSettings !== undefined && nextSettings !== settingsRevision) {
        settingsRevision = nextSettings;
        setDraftSettings(readDraftSettings(scope, draftKey));
      }
    });
  }, [scope, draftKey, sectionId]);
  const prompt = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusRequest)
      prompt.current
        ?.querySelector<HTMLElement>('textarea, [contenteditable="true"]')
        ?.focus();
  }, [focusRequest]);
  const [pending, setPending] = useState(() => readPending(scope, draftKey));
  const selectedAgent = pending?.agent;
  const available =
    session.workSessions.available &&
    (!!pending?.messageId || session.soloPlacement.available);
  const [channelId] = useState(() => pending?.id ?? crypto.randomUUID());
  const [editing, setEditing] = useState(
    // Older builds admitted untagged drafts. Preserve their creation/placement
    // progress, but let their author add a tag before any unsigned send.
    () =>
      !!(
        pending &&
        !pending.messageId &&
        !pending.agent &&
        !mentionDraft(pending.draft).recipients.length
      ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submitting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const save = (next: PendingStart) => {
    if (!writeView(scope, `${draftKey}:pending`, next))
      throw new Error(
        "Your session start couldn’t be saved on this device. No further changes were sent.",
      );
    setPending(next);
  };
  async function start(draft: MentionDraft) {
    if (
      submitting.current ||
      !(pending?.text ?? composerMarkdown(draft)).trim() ||
      !available
    )
      return;
    submitting.current = true;
    setBusy(true);
    setEditing(false);
    setError(undefined);
    const current: PendingStart = pending
      ? {
          ...pending,
          ...(!pending.messageId
            ? { text: composerMarkdown(draft), draft }
            : {}),
        }
      : {
          id: channelId,
          ttlSeconds: draftSettings.ttlSeconds,
          named:
            typeof draftSettings.name === "string" &&
            !!canonicalDetailsName(draftSettings.name),
          name:
            typeof draftSettings.name === "string"
              ? canonicalDetailsName(draftSettings.name) ||
                startingChatTitle(draft)
              : draftSettings.name,
          text: composerMarkdown(draft),
          draft,
        };

    const mentions = mentionDraft(current.draft).recipients.map(
      (item) => item.pubkey,
    );
    if (!current.messageId) {
      if (!mentions.length && selectedAgent) current.agent = selectedAgent;
      else delete current.agent;
    }
    const recipients = [
      ...new Set(
        mentions.length ? mentions : current.agent ? [current.agent] : [],
      ),
    ];
    try {
      if (current.name !== undefined && typeof current.name !== "string")
        throw new Error("The saved session name could not be verified.");
      // Receipts from before optional naming have no frozen title.
      if (!current.name)
        current.name = startingChatTitle(
          pending?.draft ?? pending?.text ?? current.draft ?? current.text,
        );
      const errors = detailsDraftErrors({
        name: current.name ?? "Session",
        description: "",
        visibility: "private",
        ttlSeconds: current.ttlSeconds,
      });
      if (current.name !== undefined && errors.name)
        throw new Error(errors.name);
      if (errors.lifetime) throw new Error(errors.lifetime);
      save(current); // Freeze validated name and lifetime before the first asynchronous start operation.
      if (current.setup !== undefined) {
        current.setup = parseSessionSetup(current.setup);
        if (
          current.setup.sectionId &&
          current.setup.sectionId !== selectedProject
        )
          throw new Error(
            "The saved session belongs to a different section. Reopen its original section to retry.",
          );
      }
      if (selectedProject && !current.setup && !current.creationId) {
        current.setup = await loadSessionSetup(session, selectedProject);
        if (!mounted.current) return;
      }
      if (!current.setup && !current.creationId && draftCanvas !== undefined) {
        current.setup = parseSessionSetup({
          ...(selectedProject ? { sectionId: selectedProject } : {}),
          canvas: draftCanvas,
          agents: [],
        });
      } else if (
        current.setup &&
        !current.creationId &&
        !pending?.setup &&
        draftCanvas !== undefined
      ) {
        current.setup = parseSessionSetup({
          ...current.setup,
          canvas: draftCanvas,
        });
      }
      save(current);
      if (!current.messageId) {
        await session.agentChoices.refresh();
        if (!mounted.current) return;
        if (
          [...recipients, ...(current.setup?.agents ?? [])].some(
            (key) =>
              !session.agentChoices
                .snapshot()
                .selectable.some((agent) => agent.pubkey === key),
          )
        )
          throw new Error(
            "Solo chats can only use your available agents. Check mentions and section defaults.",
          );
      }
      if (!current.creationId) {
        await session.soloPlacement.admit(current.id, {
          sectionId: current.setup?.sectionId,
        });
        if (!mounted.current) return;
        current.creationId = session.workSessions.create(
          current.id,
          current.name,
          current.ttlSeconds,
          current.named === true,
        );
        save({ ...current });
      }
      await session.workSessions.delivered(current.creationId);
      if (!mounted.current) return;
      await session.workSessions.refresh(current.id);
      if (!mounted.current) return;
      if (!current.messageId) {
        if (!current.placementDone) {
          await session.soloPlacement.set(current.id, true, {
            sectionId: current.setup?.sectionId,
          });
          if (!mounted.current) return;
          current.placementDone = true;
          save({ ...current });
        } else {
          await session.soloPlacement.refresh();
          if (!mounted.current) return;
          if (!session.soloPlacement.has(current.id))
            throw new Error(
              "This conversation was moved out of Solo. Review its placement before retrying.",
            );
        }
      }
      if (current.setup && !current.setupDone && !current.messageId) {
        await applySessionSetup(
          session,
          current.id,
          current.setup,
          () => mounted.current,
        );
        if (!mounted.current) return;
        current.setupDone = true;
        save({ ...current });
      }
      if (!current.messageId && current.agent && !mentions.length) {
        if (!current.invitationId) {
          current.invitationId = session.workSessions.invite(
            current.id,
            current.agent,
          );
          save({ ...current });
        }
        await session.workSessions.delivered(current.invitationId);
        if (!mounted.current) return;
        await session.workSessions.refresh(current.id, {
          member: current.agent,
        });
        if (!mounted.current) return;
      }
      if (!current.messageId) {
        if (mentions.length) {
          await session.workSessions.addAgents(
            current.id,
            recipients,
            () => mounted.current,
          );
          if (!mounted.current) return;
        }
        if (!session.soloPlacement.has(current.id))
          throw new Error(
            "This conversation is no longer in Solo. Open it in Team.",
          );
        current.messageId = session.messages.send(
          current.id,
          current.text,
          recipients,
        );
        save({ ...current });
      }
      await session.workSessions.delivered(current.messageId);
      if (!mounted.current) return;
      // Never overwrite a draft already opened or edited in another window.
      const source = mentionDraft(current.draft);
      if (current.agent && !source.recipients.length) {
        await session.agentChoices.refresh();
        if (!mounted.current) return;
      }
      const next =
        current.agent && !source.recipients.length
          ? legacyAssistantDraft(session, current.agent)
          : rememberedMentions(session, source, recipients);
      if (replaceView(scope, `draft:${current.id}`, null, next) === "failed")
        throw new Error(
          "Your follow-up draft couldn’t be saved on this device. Retry to finish opening the chat.",
        );
      writeView(scope, `${draftKey}:pending`, null);
      writeView(scope, `${draftKey}:settings`, null);
      writeView(scope, `${draftKey}:new-draft`, "");
      writeView(scope, `${draftKey}:new-project`, null);
      setPending(undefined);
      onStarted(current.id);
    } catch (reason) {
      if (!current.messageId && mounted.current) setEditing(true);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const failedId =
    pending &&
    [pending.messageId, pending.invitationId, pending.creationId].find(
      (id) => id && session.workSessions.failed(id),
    );
  async function editFailed() {
    if (!pending || !failedId || busy) return;
    setBusy(true);
    try {
      await session.workSessions.discardFailed(failedId);
      if (failedId === pending.creationId) {
        writeView(scope, `${draftKey}:pending`, null);
        setPending(undefined);
      } else {
        const next = { ...pending };
        if (failedId === next.invitationId) {
          delete next.invitationId;
          delete next.agent;
        } else delete next.messageId;
        save(next);
      }
      setEditing(true);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  const composer = (
    <div id="new-session-prompt" ref={prompt}>
      <MessageComposer
        chatPresentation
        personalConversation
        session={session}
        extensions={extensions}
        scope={scope}
        channelId={channelId}
        channelName="this chat"
        label="Message your agents"
        inviteAgents
        defaultMention={defaultAgent}
        // An interrupted start keeps the assistant its receipt was admitted with.
        requireMention={!selectedAgent && !pending?.messageId}
        trailingTool={
          session.soloPreferences ? (
            <ProjectControl
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
              disabled={busy || !!pending}
            />
          ) : undefined
        }
        submission={{
          draftKey: `${draftKey}:new-draft`,
          initialDraft: pending?.draft ?? pending?.text,
          receiptOnly: !!pending?.messageId,
          locked: busy || (!!pending && !editing),
          disabled: busy || !available,
          submit: (draft) => {
            void start(draft);
          },
        }}
      />
      {!available && (
        <p className={styles.availability} role="status">
          Solo preferences or channel creation are unavailable. Your draft is
          saved.
        </p>
      )}
      {pending?.agent && (
        <p className={styles.availability}>
          Recovering an earlier send with a saved agent recipient.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {error === removedSectionMessage &&
        pending?.setup?.sectionId &&
        !pending.setupDone &&
        !pending.messageId && (
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              try {
                if (!pending.setup) return;
                const { sectionId: _sectionId, ...setup } = pending.setup;
                save({ ...pending, setup });
                setError(undefined);
                setEditing(true);
              } catch (reason) {
                setError(
                  reason instanceof Error ? reason.message : String(reason),
                );
              }
            }}
          >
            Continue without section
          </Button>
        )}
      {error && failedId && (
        <Button type="button" disabled={busy} onClick={() => void editFailed()}>
          Edit and retry
        </Button>
      )}
    </div>
  );
  if (!standalone) return composer;
  return (
    <SoloDraftView
      actions={
        <IconButton
          ref={settingsTrigger}
          size="toolbar"
          aria-label="Chat settings"
          title="Chat settings"
          icon={<GearIcon size="1rem" aria-hidden="true" />}
          disabled={busy || !!pending}
          onClick={() => setSettingsOpen(true)}
        />
      }
    >
      {composer}
      {settingsOpen && (
        <DraftSettings
          finalFocus={settingsTrigger}
          session={session}
          sectionId={selectedProject || undefined}
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

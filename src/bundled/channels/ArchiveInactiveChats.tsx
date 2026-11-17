import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { followUpQueue } from "../../features/messages/follow-up-queue";
import { ChannelLifecycleUnconfirmed } from "../../features/relay/channel-lifecycle";
import { ApiPaused } from "../../features/relay/http-admission";
import {
  lifecycleOffer,
  ownerEvidence,
} from "../../features/relay/channel-lifecycle-protocol";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import {
  ToastNotice,
  useToastNotification,
} from "../../shared/design-system/ui/Toast";
import { workingAgents } from "./working-agents";

/** A chat with no message for this long counts as inactive. */
export const INACTIVE_DAYS = 14;
const INACTIVE_SECONDS = INACTIVE_DAYS * 24 * 60 * 60;

/** Agent work running, a follow-up queued, or a message still sending. */
function busy(session: RelaySession, channelId: string) {
  return (
    workingAgents(session.agentActivity.snapshot(), channelId).length > 0 ||
    followUpQueue(session)
      .snapshot()
      .some((entry) => entry.channelId === channelId) ||
    (session.outbox?.snapshot() ?? []).some(
      (item) =>
        item.delivery !== "accepted" &&
        item.delivery !== "seen" &&
        item.event.tags.some(
          ([key, value]) => key === "h" && value === channelId,
        ),
    )
  );
}

/** Whether the viewer can archive this chat as inactive now: its newest
 * message (or, with none, its creation) is at least 14 days old, and nothing
 * is running or waiting in it. Unknown activity is never inactive. */
export function inactiveChat(
  session: RelaySession,
  channel: ChannelSummary,
  nowSeconds: number,
) {
  if (channel.archived || channel.pending || !channel.activityKnown)
    return false;
  const last = channel.lastActivityAt ?? channel.createdAt;
  if (last === undefined || nowSeconds - last < INACTIVE_SECONDS) return false;
  const viewer = session.viewer ?? "";
  const agentOwner = ownerEvidence(channel, viewer).some(
    (key) => session.profiles.owner?.(key) === viewer,
  );
  return (
    !!lifecycleOffer(channel, viewer, agentOwner)?.canArchive &&
    !busy(session, channel.id)
  );
}

export type InactiveChatsRun = Readonly<{
  key: number;
  /** Archive asks first; unarchive is an Undo and runs at once. */
  action: "archive" | "unarchive";
  workspaceId: string;
  ids: readonly string[];
}>;

const workspaceHeading = (id: string) =>
  document.querySelector<HTMLElement>(
    `[data-solo-menu-id="project-${CSS.escape(id)}"]:not([inert] *) button`,
  );

const chats = (count: number) => (count === 1 ? "1 chat" : `${count} chats`);

/** Archives or restores a workspace's chats one at a time: the relay runs one
 * lifecycle action per session and confirms each. */
export function ArchiveInactiveChats({
  session,
  run,
  eligible,
  undo,
  close,
}: {
  session: RelaySession;
  run: InactiveChatsRun;
  /** Checked again right before each chat is archived. */
  eligible(id: string): boolean;
  /** Queues the restore; called from the result toast after this closes. */
  undo(run: Omit<InactiveChatsRun, "key">): void;
  close(): void;
}) {
  // A run outlives renders: read the caller's current callbacks when used.
  const callbacks = useRef({ eligible, undo, close });
  useLayoutEffect(() => {
    callbacks.current = { eligible, undo, close };
  });
  const archive = run.action === "archive";
  const total = run.ids.length;
  const notify = useToastNotification();
  const cancel = useRef<HTMLButtonElement>(null);
  const operation = useRef<AbortController | undefined>(undefined);
  const [progress, setProgress] = useState<number>();
  useEffect(() => () => operation.current?.abort(), []);
  const start = async () => {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    const done: string[] = [];
    // Archived, or possibly archived by a request the relay didn't confirm.
    const restorable: string[] = [];
    let failed = 0;
    let failure = "";
    for (const [index, id] of run.ids.entries()) {
      setProgress(index);
      // Checked again just before publishing, after the relay reads.
      const eligible = () => !archive || callbacks.current.eligible(id);
      if (!eligible()) continue;
      try {
        await session.channelLifecycle.run(
          run.action,
          id,
          controller.signal,
          eligible,
        );
        done.push(id);
        restorable.push(id);
      } catch (error) {
        if (controller.signal.aborted) return;
        // The chat became active while its archive was prepared.
        if (error instanceof DOMException && error.name === "AbortError")
          continue;
        if (error instanceof ChannelLifecycleUnconfirmed) restorable.push(id);
        failed += 1;
        failure ||= error instanceof Error ? error.message : String(error);
        // Paused requests would fail every remaining chat the same way.
        if (error instanceof ApiPaused) break;
      }
    }
    if (controller.signal.aborted) return;
    const verb = archive ? "archive" : "restore";
    if (!restorable.length)
      notify(
        failed
          ? `Couldn’t ${verb} ${chats(failed)}. ${failure}`
          : "No inactive chats left to archive",
        failed ? "error" : "info",
      );
    else
      notify(
        `${archive ? "Archived" : "Restored"} ${chats(done.length)}${
          failed ? `. Couldn’t ${verb} ${failed}. ${failure}` : ""
        }`,
        failed ? "info" : "success",
        archive
          ? {
              label: "Undo",
              onClick: () =>
                callbacks.current.undo({
                  action: "unarchive",
                  workspaceId: run.workspaceId,
                  ids: restorable,
                }),
            }
          : undefined,
      );
    callbacks.current.close();
  };
  // The confirmation unmounts once the run starts; focus returns to its
  // workspace heading rather than the page.
  const started = progress !== undefined;
  useLayoutEffect(() => {
    if (started && archive) workspaceHeading(run.workspaceId)?.focus();
  }, [started, archive, run.workspaceId]);
  // Undo was chosen from the result toast, so it starts at once. Deferring the
  // start lets a development StrictMode remount cancel it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: start once per mounted Undo.
  useEffect(() => {
    if (archive) return;
    const timer = setTimeout(() => void start());
    return () => clearTimeout(timer);
  }, []);
  if (progress !== undefined)
    return (
      <ToastNotice
        title={archive ? "Archiving inactive chats…" : "Restoring chats…"}
        description={`${progress + 1} of ${total}`}
        tone="info"
      />
    );
  if (!archive) return null;
  return (
    <AlertDialog
      title="Archive inactive chats"
      description={
        total
          ? `${total === 1 ? "1 chat has" : `${total} chats have`} been inactive for the last ${INACTIVE_DAYS} days.`
          : `No chats have been inactive for the last ${INACTIVE_DAYS} days.`
      }
      initialFocus={cancel}
      finalFocus={() => workspaceHeading(run.workspaceId) ?? true}
      onClose={close}
      actions={
        <>
          <Button ref={cancel} type="button" onClick={close}>
            {total ? "Cancel" : "Close"}
          </Button>
          {total > 0 && (
            <Button
              type="button"
              variant="prominent"
              onClick={() => void start()}
            >
              Archive {chats(total)}
            </Button>
          )}
        </>
      }
    />
  );
}

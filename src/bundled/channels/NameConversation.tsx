import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ComponentProps } from "react";
import type {
  ChannelMessage,
  ChannelSummary,
} from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import { splitPartition } from "../../features/relay/partition";
import { conversationTarget } from "../../features/channel-navigation/routes";
import { AvatarEditor } from "../../features/profiles/AvatarEditor";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { formatItemTimestamp } from "../../shared/datetime";

/** Where a named conversation's history starts. */
type History = "all" | "today" | "message";

/** Naming is offered on an unnamed DM the viewer is in, while writes work. */
export function canNameConversation(
  session: RelaySession,
  channel: ChannelSummary | undefined,
) {
  return !!(
    channel &&
    channel.channelType === "dm" &&
    session.directMessages?.nameable &&
    !channel.cached &&
    !channel.readOnly
  );
}

/** "New conversation from here": a top-level message the relay accepted in a
 * DM the viewer can name. A reply can't start one; its thread goes along. */
export function canStartConversationFrom(
  message: ChannelMessage,
  session: RelaySession,
) {
  return (
    !message.threadRootId &&
    (!message.delivery || ["accepted", "seen"].includes(message.delivery)) &&
    canNameConversation(session, session.channels.get?.(message.channelId))
  );
}

/**
 * Give a DM a name and picture. With all its history, the DM itself becomes
 * the named conversation, and these people's next DM starts empty. From a
 * point, the messages from there on move to a new conversation and the
 * earlier ones stay in the DM.
 */
export function NameConversation({
  session,
  navigation,
  channel,
  from,
  close,
  finalFocus,
}: {
  session: RelaySession;
  navigation: Navigation;
  channel: ChannelSummary;
  /** Opened from a message: history starts there. */
  from?: ChannelMessage | undefined;
  close(): void;
  finalFocus?: ComponentProps<typeof Dialog>["finalFocus"];
}) {
  const notify = useToastNotification();
  const [open, setOpen] = useState(true);
  const [name, setName] = useState("");
  const [picture, setPicture] = useState("");
  const [history, setHistory] = useState<History>(from ? "message" : "all");
  const [pictureBusy, setPictureBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState("");
  const [failure, setFailure] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  const lifetime = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const people = usePeopleNames(session, channel);
  const community = splitPartition(session.scope)?.communityOrigin;
  const trimmed = name.trim();
  const title = trimmed ? `“${trimmed}”` : "the new conversation";

  const historyOptions = [
    { value: "all", label: "All messages" },
    { value: "today", label: "Messages from today" },
    ...(from
      ? [
          {
            value: "message",
            label: `From ${formatItemTimestamp(from.createdAt, { withTime: true })}`,
          },
        ]
      : []),
  ];

  async function save() {
    const controller = lifetime.current;
    if (!controller || busy || pictureBusy) return;
    if (!trimmed) {
      setNameError("Add a name.");
      nameInput.current?.focus();
      return;
    }
    const writes = session.directMessages;
    if (!writes?.nameable) return;
    setBusy(true);
    setFailure("");
    try {
      let target = channel.id;
      if (history === "all")
        await writes.name(
          channel.id,
          { name: trimmed, ...(picture ? { picture } : {}) },
          controller.signal,
        );
      else {
        const moved = await writes.move(
          channel.id,
          {
            ...(history === "message" && from
              ? { cut: from.id }
              : { since: startOfToday() }),
            name: trimmed,
            ...(picture ? { picture } : {}),
          },
          controller.signal,
        );
        target = moved.channelId;
        if ("pictureFailed" in moved)
          notify("Messages moved, but the picture didn’t save.", "error");
      }
      if (controller.signal.aborted) return;
      setOpen(false);
      if (target !== channel.id)
        void navigation.open(conversationTarget(session.scope, target));
    } catch (reason) {
      if (!controller.signal.aborted) {
        const message =
          reason instanceof Error ? reason.message : String(reason);
        setFailure(message);
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      size="compact"
      footerGap="compact"
      title="Name and picture"
      description={
        history === "all"
          ? `This conversation moves to ${title}. Your next message to ${people} starts fresh.`
          : `${history === "today" ? "Today’s messages" : "Messages from here on"} move to ${title}, with everyone here. Earlier messages stay in this DM.`
      }
      artwork={
        <AvatarEditor
          emptyStyle="dotted-circle"
          triggerLabel="Choose picture"
          icons
          value={picture}
          name={trimmed || channel.name}
          community={community}
          disabled={busy}
          onBusyChange={setPictureBusy}
          onChange={setPicture}
        />
      }
      initialFocus={nameInput}
      finalFocus={finalFocus}
      preventClose={busy}
      onOpenChange={(next) => {
        if (!next) setOpen(false);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) close();
      }}
      actions={
        <>
          <Button onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="prominent"
            disabled={busy || pictureBusy}
            onClick={() => void save()}
          >
            {history === "all" ? "Save" : "Move messages"}
          </Button>
        </>
      }
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field label="Name" error={nameError || undefined}>
          <Input
            ref={nameInput}
            value={name}
            maxLength={80}
            autoComplete="off"
            placeholder="Site refresh"
            disabled={busy}
            onChange={(event) => {
              setName(event.target.value);
              if (nameError) setNameError("");
            }}
          />
        </Field>
        <Select
          label="Messages"
          variant="field"
          value={history}
          groups={[{ label: "", options: historyOptions }]}
          disabled={busy}
          onValueChange={(value) => {
            if (value === "all" || value === "today" || value === "message") {
              setHistory(value);
              setFailure("");
            }
          }}
        />
        {failure && (
          <p role="alert" className="text-body-sm text-danger">
            {failure}
          </p>
        )}
      </form>
    </Dialog>
  );
}

function startOfToday() {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  return Math.floor(day.getTime() / 1000);
}

/** "Tom and Molly": the DM's other people, as the warning names them. */
function usePeopleNames(session: RelaySession, channel: ChannelSummary) {
  const others = channel.participants ?? [];
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const names = others.map(
    (key) => profiles.get(key)?.name?.trim() || "someone",
  );
  if (!names.length) return "these people";
  if (names.length > 3) return `these ${names.length} people`;
  return new Intl.ListFormat(undefined, {
    style: "long",
    type: "conjunction",
  }).format(names);
}

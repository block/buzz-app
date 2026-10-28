// Share: send the agent to people, list it in its community's Marketplace, or
// export it as a file.
import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  catalogContent,
  catalogHead,
  isShared,
  publishShare,
  shareable,
  snapshotJson,
  snapshotPng,
} from "../../features/agents/agent-share";
import type { Agent, RegisteredAgentType } from "../../features/agents/service";
import type { EventData } from "../../features/relay/events";
import { downloadNativeFile } from "../../features/messages/native-download";
import type { UploadedAttachment } from "../../features/relay/attachments";
import type { RelaySession } from "../../features/relay/session";
import { bundledPoster } from "../../features/agents/avatar-packs";
import { avatarSource } from "../../shared/avatar-source";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import {
  MenuRadioGroup,
  MenuRadioItem,
} from "../../shared/design-system/ui/Menu";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { SplitButton } from "../../shared/design-system/ui/SplitButton";
import { SwitchPreferenceRow } from "../../shared/design-system/ui/SwitchPreferenceRow";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { RecipientPicker } from "../../features/direct-messages/RecipientPicker";
import type { Recipient } from "../../features/direct-messages/usePeople";
import browseStyles from "./AgentBrowse.module.css";
import styles from "./AgentShareDialog.module.css";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
/** What went wrong in a sentence of its own. */
const errorText = (error: unknown) => {
  const text = message(error);
  return /[.!?]$/.test(text) ? text : `${text}.`;
};

/** How long export waits for the picture, which keeps the dialog open. */
const ARTWORK_MS = 5000;

/** The picture redrawn as a 512×512 PNG, as earlier Buzz exported it. Missing,
 * unreadable or slow artwork leaves the snapshot without it. */
async function artwork(picture: string | undefined, session: RelaySession) {
  const source = avatarSource(picture);
  // Pack art is read from the app's own copy; other pictures go through the
  // session's media path.
  const src = source?.startsWith("data:")
    ? source
    : source && (bundledPoster(source) ?? session.media(source));
  if (!src) return undefined;
  const image = new Image();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    image.crossOrigin = "anonymous";
    image.src = src;
    await Promise.race([
      image.decode(),
      new Promise((_, reject) => {
        timer = setTimeout(reject, ARTWORK_MS);
      }),
    ]);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 512;
    canvas.getContext("2d")?.drawImage(image, 0, 0, 512, 512);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
  } catch {
    // Stops a load still in flight.
    image.src = "";
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** A plain, bounded file name on every desktop, where Windows reserves device
 * names such as `CON` whatever the extension. */
function fileName(name: string, format: string) {
  const stem = name.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 64);
  const plain = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)
    ? `${stem}-agent`
    : stem;
  return `${plain}.agent.${format}`;
}

/** Desktop saves natively and says where; a browser downloads the file to
 * wherever its settings say. */
async function saveFile(file: Blob, name: string): Promise<string | undefined> {
  if (isTauri()) return downloadNativeFile(file, name);
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // WebKit may still be reading the blob when click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const pendingSends = new WeakMap<
  RelaySession,
  Map<string, { channel: string; id: string }>
>();
/** Messages sent from Share and not yet confirmed, per community session. */
function unconfirmed(session: RelaySession) {
  const sent = pendingSends.get(session) ?? new Map();
  pendingSends.set(session, sent);
  return sent;
}

/** Names in a sentence: "Ana", "Ana and Ben", "Ana, Ben and Cy". */
const names = (people: readonly Recipient[]) =>
  people.length < 2
    ? (people[0]?.name ?? "")
    : `${people
        .slice(0, -1)
        .map((person) => person.name)
        .join(", ")} and ${people.at(-1)?.name}`;

export function AgentShareDialog({
  agent,
  type,
  session,
  scope,
  onClose,
}: {
  agent: Agent;
  type: RegisteredAgentType | undefined;
  session: RelaySession;
  /** The view-state partition that ranks people in the To field. */
  scope: string;
  onClose(): void;
}) {
  const notify = useToastNotification();
  // `null` while the catalog is read; `undefined` once read with no head.
  const [head, setHead] = useState<EventData | undefined | null>(null);
  const [pending, setPending] = useState<"listing" | "export" | "send">();
  // Publishing and removing are reviewed in a step of this dialog.
  const [view, setView] = useState<"share" | "publish" | "remove">("share");
  const [failure, setFailure] = useState("");
  const [error, setError] = useState("");
  const [format, setFormat] = useState<"png" | "json">("png");
  const [people, setPeople] = useState<Recipient[]>([]);
  // The read failed; clearing it reads again.
  const [unread, setUnread] = useState(false);
  const attempt = useRef<AbortController>(null);
  useEffect(() => {
    if (unread) return;
    const controller = new AbortController();
    attempt.current = controller;
    catalogHead(session, agent.owner, agent.pubkey, controller.signal).then(
      setHead,
      () => !controller.signal.aborted && setUnread(true),
    );
    return () => controller.abort();
  }, [session, agent.owner, agent.pubkey, unread]);
  // A step starts on its Cancel; returning lands on what opened it.
  const cancel = useRef<HTMLButtonElement>(null);
  const listing = useRef<HTMLDivElement>(null);
  const update = useRef<HTMLButtonElement>(null);
  const opener = useRef<"switch" | "update">("switch");
  const previousView = useRef(view);
  useLayoutEffect(() => {
    if (view !== previousView.current)
      (view === "share"
        ? (opener.current === "update" && update.current) ||
          listing.current?.querySelector<HTMLElement>("[role='switch']")
        : cancel.current
      )?.focus();
    previousView.current = view;
  }, [view]);
  const open = (next: "publish" | "remove", from: "switch" | "update") => {
    opener.current = from;
    setFailure("");
    setView(next);
  };
  // A share is a copy: edits reach the Marketplace only when it is updated.
  let definition: ReturnType<typeof shareable> | undefined;
  let refused = "";
  try {
    definition = shareable(agent, type);
  } catch (reason) {
    refused = message(reason);
  }
  const current = definition && catalogContent(definition);
  const listed = isShared(head ?? undefined);
  const stale = !!head && listed && current !== head.content;
  const share = async (shared: boolean) => {
    const signal = attempt.current?.signal;
    if (head === null || pending || !signal) return;
    setPending("listing");
    setFailure("");
    let reason = "Try again.";
    let content: string | undefined;
    try {
      // Removing keeps what was shared, so it never depends on the agent
      // still being shareable.
      content =
        !shared && head ? head.content : catalogContent(shareable(agent, type));
      await publishShare(session, agent.pubkey, content, shared, head, signal);
    } catch (error) {
      reason = message(error);
    }
    // An accepted publish can still lose to a newer head, and an unanswered
    // one may still have landed, so the relay says which head won. Until it
    // answers, the last head it confirmed stands.
    const next = await catalogHead(
      session,
      agent.owner,
      agent.pubkey,
      signal,
    ).catch(() => head);
    setPending(undefined);
    if (signal.aborted) return;
    setHead(next);
    // An update to a listed agent leaves it listed whatever happened, so a
    // publish has landed only when the winning head is what it sent.
    if (
      shared ? isShared(next) && next?.content === content : !isShared(next)
    ) {
      notify(
        shared
          ? `Published ${agent.name} to the Marketplace.`
          : `Removed ${agent.name} from the Marketplace.`,
        "success",
      );
      setView("share");
    } else
      setFailure(
        `Couldn’t ${shared ? "publish" : "remove"} ${agent.name}. ${reason}`,
      );
  };
  const file = async (as: "png" | "json") =>
    definition &&
    (as === "png"
      ? snapshotPng(definition, await artwork(agent.picture, session))
      : new Blob([snapshotJson(definition)], { type: "application/json" }));
  const save = async () => {
    if (pending || !definition) return;
    setPending("export");
    setError("");
    try {
      const snapshot = await file(format);
      if (!snapshot) return;
      const path = await saveFile(snapshot, fileName(agent.name, format));
      notify(
        path ? `Saved ${agent.name} to ${path}.` : `Exported ${agent.name}.`,
        "success",
      );
    } catch (reason) {
      setError(`Couldn’t export ${agent.name}. ${message(reason)}`);
    } finally {
      setPending(undefined);
    }
  };
  // Each person's unconfirmed message, kept past closing the window, so a
  // retry confirms it (delivery retries it in the outbox) rather than
  // sending another.
  const sent = unconfirmed(session);
  const key = (person: Recipient) => `${agent.pubkey}:${person.pubkey}`;
  const primary = useRef<HTMLButtonElement>(null);
  const upload = useRef<UploadedAttachment>(undefined);
  const sending = useRef<AbortController>(null);
  useEffect(() => () => sending.current?.abort(), []);
  const send = async () => {
    if (pending || !definition || !people.length) return;
    const uploads = session.attachments;
    if (!uploads || !session.directMessages.available) {
      setError("This community can’t send agents in messages.");
      return;
    }
    const controller = new AbortController();
    sending.current = controller;
    const { signal } = controller;
    setPending("send");
    setError("");
    const failed: Recipient[] = [];
    const reasons = new Set<string>();
    for (const person of people) {
      try {
        let message = sent.get(key(person));
        if (!message) {
          const channel = await session.directMessages.open(
            [person.pubkey],
            signal,
          );
          // One upload serves every message: community media isn't scoped
          // to a conversation.
          upload.current ??= await uploads.upload(
            new File(
              [(await file("png")) as Blob],
              fileName(agent.name, "png"),
              { type: "image/png" },
            ),
            channel,
            signal,
          );
          message = {
            channel,
            id: session.messages.send(
              channel,
              `Here’s a copy of my agent **${agent.name}**. To add it, open **Agents**, choose **Import an agent**, then pick this file.`,
              [],
              [upload.current],
            ),
          };
          sent.set(key(person), message);
        }
        await session.directMessages.delivered(
          message.id,
          message.channel,
          signal,
        );
      } catch (error) {
        if (signal.aborted) return;
        failed.push(person);
        reasons.add(errorText(error));
      }
    }
    if (signal.aborted) return;
    setPending(undefined);
    const delivered = people.filter((person) => !failed.includes(person));
    for (const person of delivered) sent.delete(key(person));
    if (delivered.length)
      notify(`Sent ${agent.name} to ${names(delivered)}.`, "success");
    // Who it couldn't reach stays chosen, to try again.
    setPeople(failed);
    if (failed.length)
      setError(
        `Couldn’t send to ${names(failed)}. ${reasons.size === 1 ? [...reasons][0] : "Try again."}`,
      );
    // Send gives way to Done once everyone is reached; focus follows it.
    requestAnimationFrame(() => primary.current?.focus());
  };
  const back = () => {
    setFailure("");
    setView("share");
  };
  const busy = !!pending;
  if (view !== "share") {
    const publishing = view === "publish";
    const title = publishing
      ? `${stale ? "Update" : "Publish"} ${agent.name} ${stale ? "in" : "to"} the Marketplace`
      : `Remove ${agent.name} from the Marketplace?`;
    return (
      <Dialog
        open
        size="compact"
        headerGap="compact"
        step={{ key: view, scale: 0.95 }}
        title={title}
        description={
          publishing
            ? "Anyone in this community can find and add a copy."
            : "People who already added a copy keep it."
        }
        closeLabel={`Back to Share ${agent.name}`}
        preventClose={busy}
        onOpenChange={(open) => {
          if (!open) back();
        }}
        actions={
          <>
            <Button ref={cancel} disabled={busy} onClick={back}>
              Cancel
            </Button>
            <Button
              variant={publishing ? "prominent" : "destructive"}
              loading={busy}
              disabled={publishing && !definition}
              onClick={() => void share(publishing)}
            >
              {publishing ? (stale ? "Update" : "Publish") : "Remove"}
            </Button>
          </>
        }
      >
        {(publishing || failure) && (
          <div className="grid gap-3">
            {publishing && (
              <div className="grid gap-2">
                <InlineHeader title="Instructions" />
                <section
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: long instructions scroll with the keyboard.
                  tabIndex={0}
                  aria-label="Instructions"
                  className={`${browseStyles.instructions} ${styles.instructions} buzz-thin-scrollbar`}
                >
                  {definition?.instructions ||
                    "This agent has no instructions."}
                </section>
                <p className="m-0 text-body-sm text-secondary">
                  Memories, chats, and saved logins aren’t included.
                </p>
              </div>
            )}
            {(failure || (publishing && refused)) && (
              <p role="alert" className="m-0 text-body-sm text-danger">
                {failure || `${agent.name} can’t be shared. ${refused}`}
              </p>
            )}
          </div>
        )}
      </Dialog>
    );
  }
  return (
    <Dialog
      open
      headerGap="compact"
      step={{ key: "share", scale: 1.05 }}
      title={`Share ${agent.name}`}
      description="Everyone gets their own copy. Later changes won’t sync."
      preventClose={busy}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      leadingActions={
        <SplitButton
          aria-label={`Export ${agent.name} as ${format === "png" ? "an image" : "JSON"}`}
          menuLabel="Choose an export format"
          loading={pending === "export"}
          disabled={busy || !definition}
          onClick={() => void save()}
          menu={
            <MenuRadioGroup
              value={format}
              onValueChange={(value: string) =>
                setFormat(value as "png" | "json")
              }
            >
              <MenuRadioItem value="png" closeOnClick>
                Image
              </MenuRadioItem>
              <MenuRadioItem value="json" closeOnClick>
                JSON
              </MenuRadioItem>
            </MenuRadioGroup>
          }
        >
          {format === "png" ? "Export" : "Export JSON"}
        </SplitButton>
      }
      actions={
        people.length ? (
          <Button
            ref={primary}
            variant="prominent"
            loading={pending === "send"}
            disabled={busy || !definition}
            onClick={() => void send()}
          >
            Send
          </Button>
        ) : (
          <Button
            ref={primary}
            variant="prominent"
            disabled={busy}
            onClick={onClose}
          >
            Done
          </Button>
        )
      }
    >
      <div className="grid gap-4">
        {refused && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {agent.name} can’t be shared. {refused}
          </p>
        )}
        <div className="grid gap-2">
          <RecipientPicker
            session={session}
            scope={scope}
            selected={people}
            disabled={busy || !definition}
            initiallyOpen={false}
            onChange={(next) => {
              setPeople(next);
              setError("");
            }}
            onComplete={() => primary.current?.focus()}
          />
          <p className="m-0 text-body-sm text-secondary">
            Each person gets a message from you with the agent attached.
          </p>
        </div>
        <div ref={listing} className="grid gap-2">
          <SettingsGroup>
            <SwitchPreferenceRow
              label="Post to Marketplace"
              description={
                unread
                  ? "Couldn’t check the Marketplace."
                  : head === null
                    ? "Checking the Marketplace…"
                    : stale
                      ? "Your latest changes aren’t in the Marketplace yet."
                      : listed
                        ? "Anyone in this community can find and add a copy."
                        : "Let anyone in this community find and add a copy."
              }
              checked={listed}
              disabled={
                head === null || unread || busy || (!listed && !definition)
              }
              onCheckedChange={(on) =>
                open(on ? "publish" : "remove", "switch")
              }
            />
          </SettingsGroup>
          {unread && (
            <Button size="sm" onClick={() => setUnread(false)}>
              Try again
            </Button>
          )}
          {stale && (
            <Button
              ref={update}
              size="sm"
              disabled={busy || !definition}
              onClick={() => open("publish", "update")}
            >
              Update Marketplace…
            </Button>
          )}
        </div>
        {error && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

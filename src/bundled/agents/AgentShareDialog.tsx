// Share: the agent's Marketplace listing in its community, and a file export.
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
import type { RelaySession } from "../../features/relay/session";
import { bundledPoster } from "../../features/agents/avatar-packs";
import { avatarSource } from "../../shared/avatar-source";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { AgentPortrait } from "./AgentCard";
import browseStyles from "./AgentBrowse.module.css";
import pageStyles from "./AgentsPage.module.css";
import styles from "./AgentShareDialog.module.css";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

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

/** A row's latest outcome, which replaces its status line. */
type Outcome = { text: string; failed?: boolean };

/** The status line a row announces, and an outcome in its place. */
function Status({
  line,
  outcome,
}: {
  line: string;
  outcome?: Outcome | undefined;
}) {
  return outcome?.failed ? (
    <span role="alert" className="text-danger">
      {outcome.text}
    </span>
  ) : (
    <span role="status">{outcome?.text ?? line}</span>
  );
}

export function AgentShareDialog({
  agent,
  type,
  session,
  onClose,
}: {
  agent: Agent;
  type: RegisteredAgentType | undefined;
  session: RelaySession;
  onClose(): void;
}) {
  // `null` while the catalog is read; `undefined` once read with no head.
  const [head, setHead] = useState<EventData | undefined | null>(null);
  const [pending, setPending] = useState<"listing" | "download">();
  const [listing, setListing] = useState<Outcome>();
  const [download, setDownload] = useState<Outcome>();
  // Publishing and removing are reviewed in a step of this dialog.
  const [view, setView] = useState<"share" | "publish" | "remove">("share");
  const [failure, setFailure] = useState("");
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
  // A step starts on its Cancel; returning lands on the button that opened
  // it, or the row's action that replaced it.
  const cancel = useRef<HTMLButtonElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const opener = useRef<string>(undefined);
  const previousView = useRef(view);
  useLayoutEffect(() => {
    if (view !== previousView.current)
      (view === "share"
        ? (() => {
            const buttons = [
              ...(actions.current?.querySelectorAll("button") ?? []),
            ];
            return (
              buttons.find(
                (button) =>
                  button.getAttribute("aria-label") === opener.current,
              ) ?? buttons[0]
            );
          })()
        : cancel.current
      )?.focus();
    previousView.current = view;
  }, [view]);
  // The row's status region mounts with the returning step; the outcome
  // follows it, so screen readers announce it as a change.
  const [announce, setAnnounce] = useState<Outcome>();
  useEffect(() => {
    if (view === "share" && announce) {
      setListing(announce);
      setAnnounce(undefined);
    }
  }, [view, announce]);
  const open = (next: "publish" | "remove", label: string) => {
    opener.current = label;
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
    setListing(undefined);
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
      setAnnounce({
        text: shared
          ? "Published to the Marketplace."
          : "Removed from the Marketplace.",
      });
      setView("share");
    } else
      setFailure(
        `Couldn’t ${shared ? "publish" : "remove"} ${agent.name}. ${reason}`,
      );
  };
  const save = async (format: "png" | "json") => {
    if (pending || !definition) return;
    setPending("download");
    setDownload(undefined);
    try {
      const file =
        format === "png"
          ? snapshotPng(definition, await artwork(agent.picture, session))
          : new Blob([snapshotJson(definition)], { type: "application/json" });
      const path = await saveFile(file, fileName(agent.name, format));
      setDownload({ text: path ? `Saved to ${path}.` : "Exported." });
    } catch (reason) {
      setDownload({
        text: `Couldn’t export ${agent.name}. ${message(reason)}`,
        failed: true,
      });
    }
    setPending(undefined);
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
      size="compact"
      headerGap="compact"
      step={{ key: "share", scale: 1.05 }}
      title={`Share ${agent.name}`}
      description="Everyone gets their own copy. Later changes won’t sync."
      artwork={
        <div className={pageStyles.importPortrait} aria-hidden="true">
          <AgentPortrait agent={agent} community={agent.relay || undefined} />
        </div>
      }
      preventClose={busy}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className="grid gap-3">
        {refused && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {agent.name} can’t be shared. {refused}
          </p>
        )}
        <SettingsGroup>
          <PreferenceRow
            title="Marketplace"
            subtitle={
              <Status
                line={
                  unread
                    ? ""
                    : head === null
                      ? "Checking the Marketplace…"
                      : stale
                        ? "Your latest changes aren’t in the Marketplace yet."
                        : listed
                          ? "Listed"
                          : "Not listed"
                }
                outcome={
                  unread
                    ? { text: "Couldn’t check the Marketplace.", failed: true }
                    : listing
                }
              />
            }
            trailing={
              <div ref={actions} className="flex gap-2">
                {unread ? (
                  <Button size="sm" onClick={() => setUnread(false)}>
                    Try again
                  </Button>
                ) : listed ? (
                  <>
                    {stale && (
                      <Button
                        size="sm"
                        disabled={busy || !definition}
                        aria-label={`Update ${agent.name} in the Marketplace`}
                        onClick={() =>
                          open(
                            "publish",
                            `Update ${agent.name} in the Marketplace`,
                          )
                        }
                      >
                        Update…
                      </Button>
                    )}
                    <Button
                      size="sm"
                      disabled={busy}
                      aria-label={`Remove ${agent.name} from the Marketplace`}
                      onClick={() =>
                        open(
                          "remove",
                          `Remove ${agent.name} from the Marketplace`,
                        )
                      }
                    >
                      Remove…
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    disabled={head === null || busy || !definition}
                    aria-label={`Publish ${agent.name} to the Marketplace`}
                    onClick={() =>
                      open(
                        "publish",
                        `Publish ${agent.name} to the Marketplace`,
                      )
                    }
                  >
                    Publish…
                  </Button>
                )}
              </div>
            }
          />
          <PreferenceRow
            title="Export agent"
            subtitle={
              <>
                {/* Present before any outcome, so the outcome is announced. */}
                <Status line="" outcome={download} />
                {download && " "}
                <Button
                  variant="link"
                  size="inline"
                  disabled={busy || !definition}
                  onClick={() => void save("json")}
                >
                  Export as JSON instead
                </Button>
              </>
            }
            trailing={
              <Button
                size="sm"
                loading={pending === "download"}
                disabled={busy || !definition}
                aria-label={`Export ${agent.name}`}
                onClick={() => void save("png")}
              >
                Export
              </Button>
            }
          />
        </SettingsGroup>
      </div>
    </Dialog>
  );
}

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { resolveMatch, type Contribution } from "../../plugins/contributions";
import {
  ContributionBoundary,
  contributionKey,
} from "../conversation/ContributionBoundary";
import type {
  ContributionReader,
  LinkPreviewRenderer,
} from "../conversation/contracts";
import { useTargetOpener } from "../conversation/opener";
import { XIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import styles from "./LinkPreviews.module.css";

/** A message shows this many cards before the rest fold behind one button. */
export const FOLD_AFTER = 3;

const none: readonly Contribution<LinkPreviewRenderer>[] = [];
const noSubscribe = () => () => {};
const noSnapshot = () => none;

/** Previews this person hid, as `messageId:urlHash`, newest last. Local to
 * this device: hiding is a reading preference, not a change to the message. */
const hiddenKey = "buzz.link-previews.hidden";
/** Oldest entries fall off past this. An entry is about 75 characters, so a
 * full list is under 100 KB of the origin's shared localStorage quota. */
const HIDDEN_LIMIT = 1000;
const hiddenListeners = new Set<() => void>();
let hidden: ReadonlySet<string> = readHidden();
function readHidden(): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(hiddenKey) ?? "[]");
    return new Set(
      Array.isArray(value)
        ? value.filter((item) => typeof item === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}
function hide(entry: string) {
  const next = [...hidden].filter((item) => item !== entry);
  next.push(entry);
  const kept = next.slice(-HIDDEN_LIMIT);
  hidden = new Set(kept);
  try {
    localStorage.setItem(hiddenKey, JSON.stringify(kept));
  } catch {
    // Still hidden for this session.
  }
  for (const listener of hiddenListeners) listener();
}
function subscribeHidden(listener: () => void) {
  hiddenListeners.add(listener);
  return () => {
    hiddenListeners.delete(listener);
  };
}
const hiddenSnapshot = () => hidden;
function hiddenEntry(messageId: string, url: string) {
  // FNV-1a, 32-bit: a fixed-size name for the URL within its message.
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i++)
    hash = Math.imul(hash ^ url.charCodeAt(i), 0x01000193);
  return `${messageId}:${(hash >>> 0).toString(36)}`;
}

/** One card, with the host's opener for targets other than its link. */
function LinkPreviewCard({
  url,
  messageId,
  registry,
  renderer,
  open,
}: {
  url: string;
  messageId: string;
  registry: ContributionReader<LinkPreviewRenderer>;
  renderer: Contribution<LinkPreviewRenderer>;
  open(): boolean;
}) {
  const opener = useTargetOpener(registry, renderer);
  const Preview = renderer.component;
  return (
    <Preview url={url} messageId={messageId} open={open} opener={opener} />
  );
}

export function LinkPreviews({
  urls,
  messageId,
  registry,
  onOpenLink,
}: {
  urls: readonly string[];
  messageId: string;
  registry: ContributionReader<LinkPreviewRenderer> | undefined;
  onOpenLink(url: string): boolean;
}) {
  const renderers = useSyncExternalStore(
    registry?.subscribe ?? noSubscribe,
    registry?.snapshot ?? noSnapshot,
    registry?.snapshot ?? noSnapshot,
  );
  const hiddenEntries = useSyncExternalStore(
    subscribeHidden,
    hiddenSnapshot,
    hiddenSnapshot,
  );
  const [open, setOpen] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const cards = urls.flatMap((url) => {
    const renderer = resolveMatch(renderers, url);
    return renderer && !hiddenEntries.has(hiddenEntry(messageId, url))
      ? [{ url, renderer }]
      : [];
  });
  if (!registry || !cards.length) return null;
  const shown = open ? cards : cards.slice(0, FOLD_AFTER);
  const folded = cards.length - shown.length;
  return (
    <div className={styles.previews} data-link-previews>
      {shown.map(({ url, renderer }) => {
        const key = contributionKey(renderer);
        return (
          <div key={`${key}:${url}`} className={styles.card}>
            <ContributionBoundary fallback={null} resetIdentity={key}>
              <LinkPreviewCard
                url={url}
                messageId={messageId}
                registry={registry}
                renderer={renderer}
                open={() =>
                  live.current && registry.snapshot().includes(renderer)
                    ? onOpenLink(url)
                    : false
                }
              />
            </ContributionBoundary>
            <IconButton
              size="xs"
              shape="round"
              type="button"
              data-dismiss-action=""
              aria-label="Hide link preview"
              title="Hide link preview"
              onClick={(event) => {
                // A keyboard press keeps focus in the stack once this card goes.
                if (event.detail === 0) {
                  const actions = [
                    ...(event.currentTarget
                      .closest("[data-link-previews]")
                      ?.querySelectorAll<HTMLElement>(
                        "[data-dismiss-action]",
                      ) ?? []),
                  ];
                  const at = actions.indexOf(event.currentTarget);
                  (actions[at + 1] ?? actions[at - 1])?.focus();
                }
                hide(hiddenEntry(messageId, url));
              }}
              icon={<XIcon size={16} />}
            />
          </div>
        );
      })}
      {(folded > 0 || (open && cards.length > FOLD_AFTER)) && (
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={() => setOpen((value) => !value)}
        >
          {open
            ? "Show fewer previews"
            : `Show ${folded} more ${folded === 1 ? "preview" : "previews"}`}
        </Button>
      )}
    </div>
  );
}

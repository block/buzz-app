import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { resolveMatch, type Contribution } from "../../plugins/contributions";
import {
  ContributionBoundary,
  contributionKey,
} from "../conversation/ContributionBoundary";
import type {
  ContributionReader,
  LinkPreviewRenderer,
  LinkPreviewSettings,
  LinkPreviewStatus,
} from "../conversation/contracts";
import { useTargetOpener } from "../conversation/opener";
import { XIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { combineStatuses, linkPreviewStatus } from "./link-preview-status";
import styles from "./LinkPreviews.module.css";

/** A message shows this many cards before the rest fold behind one button. */
export const FOLD_AFTER = 3;

const none: readonly Contribution<LinkPreviewRenderer>[] = [];
const noSubscribe = () => () => {};
const noSnapshot = () => none;
const noStatuses = combineStatuses([]);

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

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Drawn by the host while a renderer reports `needs-setup`. It passes no
 * message content to the plugin and runs nothing; setup happens in Settings. */
function LinkPreviewSetup({
  url,
  title,
  onOpenSettings,
  onFocusedRemoval,
}: {
  url: string;
  title: string;
  onOpenSettings(): void;
  onFocusedRemoval(): void;
}) {
  const host = hostOf(url);
  const button = useRef<HTMLButtonElement>(null);
  const removed = useRef(onFocusedRemoval);
  removed.current = onFocusedRemoval;
  // Layout cleanup runs while the button is still attached, so it can tell
  // whether a status change is about to take keyboard focus with it.
  useLayoutEffect(() => {
    const node = button.current;
    return () => {
      if (node && node.ownerDocument.activeElement === node) removed.current();
    };
  }, []);
  return (
    <button
      ref={button}
      type="button"
      className={styles.setup}
      onClick={onOpenSettings}
      data-link-preview-setup
    >
      <span className={styles.setupTitle}>Set up {title} for previews</span>{" "}
      <span className={styles.setupDetail}>{host} · Open Settings</span>
    </button>
  );
}

function shownWithin(element: HTMLElement, root: HTMLElement): boolean {
  if (element.closest("[inert], [aria-hidden='true']")) return false;
  const view = root.ownerDocument.defaultView;
  if (!view) return false;
  const { visibility } = view.getComputedStyle(element);
  if (visibility === "hidden" || visibility === "collapse") return false;
  for (
    let node: HTMLElement | null = element;
    node && node !== root;
    node = node.parentElement
  ) {
    if (node.hidden || view.getComputedStyle(node).display === "none")
      return false;
  }
  return true;
}

export function LinkPreviews({
  urls,
  messageId,
  registry,
  onOpenLink,
  settings,
}: {
  urls: readonly string[];
  messageId: string;
  registry: ContributionReader<LinkPreviewRenderer> | undefined;
  onOpenLink(url: string): boolean;
  /** Plugin Settings cards; without them, renderers that need setup draw no card. */
  settings?: LinkPreviewSettings | undefined;
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
  const matched = urls.flatMap((url) => {
    const renderer = resolveMatch(renderers, url);
    return renderer ? [{ url, renderer }] : [];
  });
  const distinct = [...new Set(matched.map(({ renderer }) => renderer))];
  const identity = distinct.map(contributionKey).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: identity names exactly the registrations in distinct.
  const statuses = useMemo(
    () =>
      registry
        ? combineStatuses(
            distinct.map((renderer) => linkPreviewStatus(registry, renderer)),
          )
        : noStatuses,
    [registry, identity],
  );
  const snapshot = useSyncExternalStore(
    statuses.subscribe,
    statuses.get,
    statuses.get,
  );
  const read = snapshot.split(",");
  const statusOf = new Map(
    distinct.map((renderer, index) => [
      renderer,
      (read[index] ?? "checking") as LinkPreviewStatus,
    ]),
  );
  const sections = distinct.map((renderer) =>
    renderer.settings ? `${renderer.pluginId}/${renderer.settings}` : "",
  );
  const readSettings = () =>
    sections
      .map((section) => (section && settings?.has(section) ? "1" : "0"))
      .join("");
  const available = useSyncExternalStore(
    settings?.subscribe ?? noSubscribe,
    readSettings,
    readSettings,
  );
  const sectionOf = new Map(
    distinct.flatMap((renderer, index) => {
      const section = sections[index];
      return section && available[index] === "1" ? [[renderer, section]] : [];
    }),
  );
  const cards = matched.flatMap(({ url, renderer }) => {
    const status = statusOf.get(renderer) ?? "checking";
    if (status === "checking") return [];
    if (hiddenEntries.has(hiddenEntry(messageId, url))) return [];
    if (status === "needs-setup" && !sectionOf.has(renderer)) return [];
    return [{ url, renderer, status }];
  });
  const container = useRef<HTMLDivElement>(null);
  const focusLost = useRef(false);
  useLayoutEffect(() => {
    if (!focusLost.current) return;
    focusLost.current = false;
    const root = container.current;
    if (!root) return;
    const active = root.ownerDocument.activeElement;
    if (active && active !== root.ownerDocument.body) return;
    const candidates = [
      ...root.querySelectorAll<HTMLElement>("[data-link-preview-setup]"),
      ...root.querySelectorAll<HTMLElement>(
        // A card's X is not a landing place: Enter there would hide it.
        ":is(a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])):not([data-dismiss-action])",
      ),
    ];
    for (const candidate of candidates) {
      if (!shownWithin(candidate, root)) continue;
      candidate.focus({ preventScroll: true });
      if (root.ownerDocument.activeElement === candidate) return;
    }
    root.focus({ preventScroll: true });
  });
  if (!registry || !matched.length) return null;
  const shown = open ? cards : cards.slice(0, FOLD_AFTER);
  const folded = cards.length - shown.length;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group, not a form fieldset, is where focus lands when a setup card goes away.
    <div
      ref={container}
      className={styles.previews}
      role="group"
      aria-label="Link previews"
      tabIndex={-1}
      data-link-previews={cards.length ? "" : undefined}
    >
      {shown.map(({ url, renderer, status }) => {
        const key = contributionKey(renderer);
        const section = sectionOf.get(renderer);
        if (status === "needs-setup" && settings && section) {
          return (
            <LinkPreviewSetup
              key={`setup:${key}:${url}`}
              url={url}
              title={renderer.title}
              onFocusedRemoval={() => {
                focusLost.current = true;
              }}
              onOpenSettings={() => {
                if (
                  registry.snapshot().includes(renderer) &&
                  settings.has(section)
                )
                  settings.open(section);
              }}
            />
          );
        }
        return (
          // The X sits inside the boundary, so a renderer that throws
          // takes its X with it.
          <ContributionBoundary
            key={`${key}:${url}`}
            fallback={null}
            resetIdentity={key}
          >
            <div className={styles.card}>
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
              <IconButton
                size="xs"
                shape="round"
                type="button"
                data-dismiss-action=""
                aria-label="Hide link preview"
                title="Hide link preview"
                onClick={(event) => {
                  // A keyboard press keeps focus in the group once this card
                  // goes: the next card's X, else the previous, else the group.
                  if (event.detail === 0) {
                    const root = container.current;
                    const actions = [
                      ...(root?.querySelectorAll<HTMLElement>(
                        "[data-dismiss-action]",
                      ) ?? []),
                    ];
                    const at = actions.indexOf(event.currentTarget);
                    (actions[at + 1] ?? actions[at - 1] ?? root)?.focus({
                      preventScroll: true,
                    });
                  }
                  hide(hiddenEntry(messageId, url));
                }}
                icon={<XIcon size={16} />}
              />
            </div>
          </ContributionBoundary>
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

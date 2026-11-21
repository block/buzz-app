import {
  useEffect,
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
  LinkPreviewStatus,
} from "../conversation/contracts";
import { useTargetOpener } from "../conversation/opener";
import { Button } from "../../shared/design-system/ui/Button";
import { combineStatuses, linkPreviewStatus } from "./link-preview-status";
import styles from "./LinkPreviews.module.css";

/** A message shows this many cards before the rest fold behind one button. */
export const FOLD_AFTER = 3;

const none: readonly Contribution<LinkPreviewRenderer>[] = [];
const noSubscribe = () => () => {};
const noSnapshot = () => none;
const noStatuses = combineStatuses([]);

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
}: {
  url: string;
  title: string;
  onOpenSettings(): void;
}) {
  const host = hostOf(url);
  return (
    <button
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

export function LinkPreviews({
  urls,
  messageId,
  registry,
  onOpenLink,
  onOpenSettings,
}: {
  urls: readonly string[];
  messageId: string;
  registry: ContributionReader<LinkPreviewRenderer> | undefined;
  onOpenLink(url: string): boolean;
  /** Opens a Settings section; without it, renderers that need setup draw no card. */
  onOpenSettings?: ((section: string) => void) | undefined;
}) {
  const renderers = useSyncExternalStore(
    registry?.subscribe ?? noSubscribe,
    registry?.snapshot ?? noSnapshot,
    registry?.snapshot ?? noSnapshot,
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
  const cards = matched.flatMap(({ url, renderer }) => {
    const status = statusOf.get(renderer) ?? "checking";
    if (status === "checking") return [];
    if (status === "needs-setup" && !(onOpenSettings && renderer.settings))
      return [];
    return [{ url, renderer, status }];
  });
  if (!registry || !cards.length) return null;
  const shown = open ? cards : cards.slice(0, FOLD_AFTER);
  const hidden = cards.length - shown.length;
  return (
    <div className={styles.previews} data-link-previews>
      {shown.map(({ url, renderer, status }) => {
        const key = contributionKey(renderer);
        if (status === "needs-setup" && onOpenSettings && renderer.settings) {
          const section = `${renderer.pluginId}/${renderer.settings}`;
          return (
            <LinkPreviewSetup
              key={`setup:${key}:${url}`}
              url={url}
              title={renderer.title}
              onOpenSettings={() => {
                if (registry.snapshot().includes(renderer))
                  onOpenSettings(section);
              }}
            />
          );
        }
        return (
          <ContributionBoundary
            key={`${key}:${url}`}
            fallback={null}
            resetIdentity={key}
          >
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
        );
      })}
      {(hidden > 0 || (open && cards.length > FOLD_AFTER)) && (
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={() => setOpen((value) => !value)}
        >
          {open
            ? "Show fewer previews"
            : `Show ${hidden} more ${hidden === 1 ? "preview" : "previews"}`}
        </Button>
      )}
    </div>
  );
}

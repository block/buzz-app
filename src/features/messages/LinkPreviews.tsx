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
import { Button } from "../../shared/design-system/ui/Button";
import { linkPreviewStatus } from "./link-preview-status";
import styles from "./LinkPreviews.module.css";

/** A message shows this many cards before the rest fold behind one button. */
export const FOLD_AFTER = 3;

const none: readonly Contribution<LinkPreviewRenderer>[] = [];
const noSubscribe = () => () => {};
const noSnapshot = () => none;

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
      aria-label={`Set up ${title} to preview ${host}`}
      onClick={onOpenSettings}
      data-link-preview-setup
    >
      <span className={styles.setupTitle}>Set up {title} for previews</span>
      <span className={styles.setupDetail}>{host} · Open Settings</span>
    </button>
  );
}

function LinkPreviewSlot({
  url,
  messageId,
  registry,
  renderer,
  open,
  onOpenSettings,
}: {
  url: string;
  messageId: string;
  registry: ContributionReader<LinkPreviewRenderer>;
  renderer: Contribution<LinkPreviewRenderer>;
  open(): boolean;
  onOpenSettings: ((section: string) => void) | undefined;
}) {
  const store = linkPreviewStatus(registry, renderer);
  const status = useSyncExternalStore(store.subscribe, store.get, store.get);
  if (status === "checking") return null;
  if (status === "needs-setup") {
    if (!onOpenSettings || !renderer.settings) return null;
    const section = `${renderer.pluginId}/${renderer.settings}`;
    return (
      <LinkPreviewSetup
        url={url}
        title={renderer.title}
        onOpenSettings={() => {
          if (registry.snapshot().includes(renderer)) onOpenSettings(section);
        }}
      />
    );
  }
  return (
    <LinkPreviewCard
      url={url}
      messageId={messageId}
      registry={registry}
      renderer={renderer}
      open={open}
    />
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
  const cards = urls.flatMap((url) => {
    const renderer = resolveMatch(renderers, url);
    return renderer ? [{ url, renderer }] : [];
  });
  if (!registry || !cards.length) return null;
  const shown = open ? cards : cards.slice(0, FOLD_AFTER);
  const hidden = cards.length - shown.length;
  return (
    <div className={styles.previews} data-link-previews>
      {shown.map(({ url, renderer }) => {
        const key = contributionKey(renderer);
        return (
          <ContributionBoundary
            key={`${key}:${url}`}
            fallback={null}
            resetIdentity={key}
          >
            <LinkPreviewSlot
              url={url}
              messageId={messageId}
              registry={registry}
              renderer={renderer}
              onOpenSettings={onOpenSettings}
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

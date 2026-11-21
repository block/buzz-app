import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { formatItemTimestamp } from "../../shared/datetime";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import {
  type ComposerView,
  composerHost,
  useComposerForm,
  useComposerScope,
} from "./composer-overlay";
import { DetailsSheet } from "./DetailsSheet";
import styles from "./Messages.module.css";

/** Which details message is open, and in which view: its channel, and the
 * thread it was opened in, if any. */
export type OpenDetails = Readonly<{
  messageId: string;
  channelId: string;
  rootId?: string | undefined;
}>;
/** A page whose address carries the open details: opening and closing them
 * are navigation. Without one, a details message opens in place. */
export type DetailsAddress = Readonly<{
  open: OpenDetails | undefined;
  show(details: OpenDetails): void;
  /** Explicit close, as ✕, Escape or a send do: retires the visit. */
  dismiss(): void;
}>;
export const DetailsAddressContext = createContext<DetailsAddress | undefined>(
  undefined,
);

/** Whether `open` names details shown in `view` of `channelId`. */
export const detailsInView = (
  open: OpenDetails | undefined,
  channelId: string,
  view: ComposerView,
) =>
  !!open &&
  view.shown &&
  open.channelId === channelId &&
  open.rootId === view.rootId;

const HEADING = /^H[1-6]$/;

/** Whether the chat holds back any of the message: a later block, or a brief
 * longer than its lines. The brief follows a leading heading when an older
 * details message has one. */
function holdsBack(clip: HTMLElement) {
  const text = clip.firstElementChild;
  if (!text) return false;
  const blocks = [...text.children];
  const shown = blocks[0] && HEADING.test(blocks[0].tagName) ? 2 : 1;
  return (
    blocks.length > shown ||
    blocks
      .slice(0, shown)
      .some((block) => block.scrollHeight > block.clientHeight + 1)
  );
}

/** A details message reads in the chat as its opening brief, and opens whole
 * over the composer of the view it sits in, or as a dialog when that composer
 * isn't on screen. The row draws the reader, so its links stay live. */
export function DetailsMessage({
  messageId,
  channelId,
  author,
  avatar,
  createdAt,
  preview,
  keepMounted,
  children,
}: {
  messageId: string;
  channelId: string;
  author: string;
  /** The author's avatar, beside their name in the reader. */
  avatar: ReactNode;
  createdAt: number;
  /** The whole message as the chat renders it; only its brief shows. */
  preview: ReactNode;
  /** Pins the row in a virtualized list while it draws the reader. */
  keepMounted?: ((messageId: string) => () => void) | undefined;
  /** The reader's body. */
  children: ReactNode;
}) {
  const view = useComposerScope();
  const address = useContext(DetailsAddressContext);
  const [local, setLocal] = useState(false);
  const addressed = !!address && !!view;
  const open = addressed
    ? address.open?.messageId === messageId &&
      detailsInView(address.open, channelId, view)
    : local;
  const show = () =>
    addressed
      ? address.show({ messageId, channelId, rootId: view.rootId })
      : setLocal(true);
  const close = () => (addressed ? address.dismiss() : setLocal(false));
  useEffect(
    () => (open ? keepMounted?.(messageId) : undefined),
    [open, keepMounted, messageId],
  );
  const form = useComposerForm(view?.handle);
  const host = open && form ? composerHost(view?.handle) : null;
  const trigger = useRef<HTMLButtonElement>(null);
  const clip = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const element = clip.current;
    if (!element) return;
    const measure = () => setClipped(holdsBack(element));
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);
  const time = formatItemTimestamp(createdAt, { withTime: true });
  const reader = <div className={styles.detailsReader}>{children}</div>;
  return (
    <div className={styles.detailsPreview} data-clipped={clipped || undefined}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Show more is the keyboard path; this only widens the pointer target. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Show more is the keyboard path; this only widens the pointer target. */}
      <div
        ref={clip}
        className={styles.detailsClip}
        onClick={(event) => {
          // Links, mentions and selected text keep their own meaning.
          if (
            !clipped ||
            (event.target instanceof Element &&
              event.target.closest("a, button, [role=button]")) ||
            !getSelection()?.isCollapsed
          )
            return;
          show();
        }}
      >
        {preview}
      </div>
      {clipped && (
        <span className={styles.detailsMore}>
          <Button
            ref={trigger}
            variant="link"
            size="inline"
            aria-haspopup="dialog"
            onClick={show}
          >
            Show more
          </Button>
        </span>
      )}
      {host ? (
        <DetailsSheet
          open
          onOpenChange={(next) => {
            if (!next) close();
          }}
          host={host}
          title={author}
          leading={avatar}
          description={time}
          finalFocus={trigger}
        >
          {reader}
        </DetailsSheet>
      ) : (
        open && (
          <Dialog
            open
            onOpenChange={(next) => {
              if (!next) close();
            }}
            title={author}
            description={time}
            visit={addressed}
            finalFocus={trigger}
          >
            {reader}
          </Dialog>
        )
      )}
    </div>
  );
}

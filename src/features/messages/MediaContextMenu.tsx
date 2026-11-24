import {
  cloneElement,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactElement,
} from "react";
import { writeClipboardText } from "../../shared/clipboard";
import {
  CopyIcon,
  ArrowsOutIcon,
  DownloadIcon,
  FolderOpenIcon,
  LinkIcon,
} from "../../shared/design-system/icons";
import {
  ContextMenuRoot,
  MenuIcon,
  MenuItem,
  MenuLinkItem,
  MenuPopup,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import { useToastDismiss } from "../../shared/design-system/ui/Toast";
import { useConversationPresentation } from "../conversation/ConversationPresentation";
import {
  isNativeMediaSource,
  isProxySource,
  safeOpenUrl,
} from "./attachment-source";
import { copyImageToClipboard, supportsImageCopy } from "./image-copy";
import { copyNativeImage } from "./native-image-copy";
import {
  downloadNativeMedia,
  openSavedDownload,
  savedDownloadStatus,
  subscribeSavedDownloads,
} from "./native-download";
import { useMediaActionNotification } from "./MediaActionAnnouncements";
import { isApplePlatform } from "../shortcuts/format";

type Target = {
  source: string;
  url: string;
  anchor: { getBoundingClientRect(): DOMRect };
  focus: HTMLElement;
  image: HTMLImageElement | null;
};

/** Received relay media has app-only display URLs. Its menu uses the original
 * URL for copying and the existing authenticated boundaries for bytes. The
 * Base UI menu mounts on demand, rather than once per attachment in a list. */
export function MediaContextMenu({
  url,
  source,
  name = "",
  kind,
  allowCopy = true,
  onView,
  children,
}: {
  url: string | undefined;
  source: string | undefined;
  name?: string | undefined;
  kind: "image" | "video";
  allowCopy?: boolean;
  onView?: (() => void) | undefined;
  children: ReactElement<HTMLAttributes<HTMLElement>>;
}) {
  const active = useConversationPresentation();
  const notify = useMediaActionNotification();
  const dismiss = useToastDismiss();
  const downloading = useRef(new Set<string>());
  const [target, setTarget] = useState<Target>();
  const [open, setOpen] = useState(false);
  const afterClose = useRef<(() => void) | undefined>(undefined);
  const handingOffFocus = useRef(false);
  useEffect(() => {
    void source;
    void url;
    void active;
    setOpen(false);
    setTarget(undefined);
    afterClose.current = undefined;
    handingOffFocus.current = false;
  }, [source, url, active]);
  const native = !!source && isNativeMediaSource(source);
  const supported =
    source && url && safeOpenUrl(url) && (native || isProxySource(source));
  const current = active && target?.source === source && target?.url === url;
  // The answer belongs to one attachment, so another forgets it. A closing
  // menu keeps it rather than dropping a row as it goes.
  const [savedCopy, setSavedCopy] = useState(false);
  useEffect(() => {
    void source;
    void name;
    setSavedCopy(false);
  }, [source, name]);
  // Only an open menu asks, so a list of attachments costs the host nothing
  // until someone wants one. Any window's download arrives as a change.
  useEffect(() => {
    if (!open || !native || !source) return;
    let mounted = true;
    const ask = () =>
      savedDownloadStatus(source, name).then(
        (saved) => mounted && setSavedCopy(saved),
        () => mounted && setSavedCopy(false),
      );
    void ask();
    const stop = subscribeSavedDownloads(() => void ask());
    return () => {
      mounted = false;
      stop();
    };
  }, [open, native, source, name]);
  const run = async (
    action: () => Promise<void>,
    success: string,
    failure: string,
    downloadSource?: string,
  ) => {
    const pending = downloading.current;
    if (downloadSource && pending.has(downloadSource)) return;
    if (downloadSource) pending.add(downloadSource);
    const notice = downloadSource
      ? notify("Starting download…", "info")
      : undefined;
    try {
      await action();
      notify(success, "success");
    } catch {
      notify(failure, "error");
    } finally {
      if (notice) dismiss(notice);
      if (downloadSource) pending.delete(downloadSource);
    }
  };
  /** Shows the host's saved copy in its folder. The file manager coming
   * forward is the answer, so only a failure is worth saying. A record the
   * host has dropped means the copy is gone, which asks for a new download. */
  const showSaved = async (saved: string) => {
    try {
      if ((await openSavedDownload(saved, name, true)) === "moved")
        notify(
          `That ${kind} is no longer in Downloads. Download it again.`,
          "error",
        );
    } catch {
      notify(`Couldn’t show the ${kind}. Try again.`, "error");
    }
  };
  const show = (element: HTMLElement, rect: DOMRect, focus?: HTMLElement) => {
    if (!source || !url) return;
    setTarget({
      source,
      url,
      anchor: { getBoundingClientRect: () => rect },
      focus:
        focus ??
        (element.matches("button, a[href], [tabindex]")
          ? element
          : (element.querySelector<HTMLElement>(
              "button, a[href], [tabindex]",
            ) ?? element)),
      // Prefer the current full-resolution image over a thumbnail or departing
      // gallery frame, including originals adopted from the decoded-image pool.
      image:
        element instanceof HTMLImageElement
          ? element
          : element.querySelector<HTMLImageElement>(
              "img[data-review-media], img:not([data-thumbnail]):not([data-gallery-departing])",
            ),
    });
    setOpen(true);
    afterClose.current = undefined;
    handingOffFocus.current = false;
  };
  return (
    <>
      {cloneElement(children, {
        onContextMenu: (event) => {
          children.props.onContextMenu?.(event);
          if (
            !active ||
            !supported ||
            event.defaultPrevented ||
            !event.currentTarget.contains(event.target as Node)
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          show(
            event.currentTarget,
            new DOMRect(event.clientX, event.clientY, 0, 0),
          );
        },
        onKeyDown: (event) => {
          children.props.onKeyDown?.(event);
          if (
            !active ||
            !supported ||
            event.defaultPrevented ||
            !(event.target instanceof HTMLElement) ||
            !event.currentTarget.contains(event.target) ||
            !(
              event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10")
            )
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          show(
            event.currentTarget,
            event.target.getBoundingClientRect(),
            event.target,
          );
        },
      })}
      {target && current && (
        <ContextMenuRoot
          open={open}
          onOpenChange={setOpen}
          onOpenChangeComplete={(next) => {
            if (next) return;
            const action = afterClose.current;
            afterClose.current = undefined;
            setTarget(undefined);
            action?.();
          }}
        >
          <MenuPopup
            size="compact"
            anchor={target.anchor}
            finalFocus={() =>
              handingOffFocus.current || !target.focus.isConnected
                ? false
                : target.focus
            }
          >
            {onView && (
              <MenuItem
                onClick={() => {
                  handingOffFocus.current = true;
                  afterClose.current = () => {
                    target.focus.focus({ preventScroll: true });
                    onView();
                  };
                }}
              >
                <MenuIcon>
                  <ArrowsOutIcon size={16} />
                </MenuIcon>
                Open {kind}
              </MenuItem>
            )}
            {kind === "image" && allowCopy && (
              <MenuItem
                disabled={!native && (!supportsImageCopy() || !target.image)}
                onClick={() =>
                  void run(
                    () => {
                      if (native) return copyNativeImage(target.source);
                      if (!target.image)
                        return Promise.reject(new Error("Image unavailable"));
                      return copyImageToClipboard(target.image);
                    },
                    "Image copied",
                    "Couldn’t copy image. Try again.",
                  )
                }
              >
                <MenuIcon>
                  <CopyIcon size={16} />
                </MenuIcon>
                Copy image
              </MenuItem>
            )}
            <MenuItem
              onClick={() =>
                void run(
                  () => writeClipboardText(target.url),
                  `${kind === "image" ? "Image" : "Video"} URL copied`,
                  "Couldn’t copy URL. Try again.",
                )
              }
            >
              <MenuIcon>
                <LinkIcon size={16} />
              </MenuIcon>
              Copy {kind} URL
            </MenuItem>
            <MenuSeparator />
            {native ? (
              <>
                {savedCopy && (
                  <MenuItem onClick={() => void showSaved(target.source)}>
                    <MenuIcon>
                      <FolderOpenIcon size={16} />
                    </MenuIcon>
                    {isApplePlatform(navigator.platform)
                      ? "Show in Finder"
                      : "Show in folder"}
                  </MenuItem>
                )}
                <MenuItem
                  onClick={() =>
                    void run(
                      () => downloadNativeMedia(target.source, name),
                      "Saved to Downloads",
                      "Couldn’t download. Try again.",
                      target.source,
                    )
                  }
                >
                  <MenuIcon>
                    <DownloadIcon size={16} />
                  </MenuIcon>
                  {savedCopy ? `Download ${kind} again` : `Download ${kind}`}
                </MenuItem>
              </>
            ) : (
              <MenuLinkItem href={target.source} download={name} closeOnClick>
                <MenuIcon>
                  <DownloadIcon size={16} />
                </MenuIcon>
                Download {kind}
              </MenuLinkItem>
            )}
          </MenuPopup>
        </ContextMenuRoot>
      )}
    </>
  );
}

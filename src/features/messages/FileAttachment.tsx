import type { FileCardProps } from "../conversation/contracts";
import {
  IconButton,
  type IconButtonProps,
} from "../../shared/design-system/ui/IconButton";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import {
  ArrowUpRightIcon,
  ArrowsClockwiseIcon,
  CheckIcon,
  CircleNotchIcon,
  DownloadIcon,
  FolderOpenIcon,
} from "../../shared/design-system/icons/index";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuIcon,
  MenuItem,
  MenuPopup,
} from "../../shared/design-system/ui/Menu";
import { FileTypeIcon } from "./FileTypeIcon";
import fileIconStyles from "./FileTypeIcon.module.css";
import type { Attachment } from "../relay/contracts";
import { isApplePlatform } from "../shortcuts/format";
import {
  isNativeMediaSource,
  isProxySource,
  safeOpenUrl,
} from "./attachment-source";
import styles from "./Messages.module.css";
import {
  downloadNativeMedia,
  openSavedDownload,
  savedDownloadStatus,
  subscribeSavedDownloads,
} from "./native-download";
import { useNativeDownload, type DownloadState } from "./use-native-download";
import { useEffect, useRef, useState, type ReactNode } from "react";

/** A native file card: `ready` has a saved copy to open; `moved` lost it. */
type FileCardState =
  | "idle"
  | "pending"
  | "ready"
  | "moved"
  | "openFailed"
  | "failed";

export function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  if (size < 1024 * 1024 * 1024)
    return `${Math.round(size / (1024 * 1024))} MB`;
  return `${Math.round(size / (1024 * 1024 * 1024))} GB`;
}

function mimeLabel(mime: string | undefined): string | undefined {
  if (!mime) return undefined;
  const [type, subtype] = mime.split("/");
  if (!type || !subtype) return undefined;
  if (subtype === "pdf") return "PDF file";
  if (!/^[a-z0-9]+$/i.test(subtype)) return undefined;
  return `${subtype.toUpperCase()} file`;
}

export function FileAttachment({
  attachment,
  source,
  onOpenLink,
  onPreview,
  typeLabel,
}: Omit<FileCardProps, "source"> & { source: string | undefined }) {
  const displayName = attachment.name ?? mimeLabel(attachment.mime) ?? "File";
  const nativeSource = source ? isNativeMediaSource(source) : false;
  const proxySource = source ? isProxySource(source) || nativeSource : false;
  const externalSource = !!source && safeOpenUrl(source) && !proxySource;
  if (source && !proxySource && !externalSource)
    return (
      <UnavailableFileAttachment
        displayName={displayName}
        attachment={attachment}
      />
    );

  if (source && proxySource && onPreview) {
    const renderPreview = (
      state: DownloadState = "idle",
      download?: () => Promise<void>,
    ) => {
      const action = {
        "aria-label": `${state === "failed" ? "Retry download" : "Download"} ${displayName}`,
        title: `Download ${displayName}`,
        icon:
          state === "failed" ? (
            <ArrowsClockwiseIcon aria-hidden="true" />
          ) : state === "saved" ? (
            <CheckIcon aria-hidden="true" />
          ) : (
            <DownloadIcon aria-hidden="true" />
          ),
        shape: "row-end",
      } satisfies IconButtonProps;
      return (
        <div className={styles.filePreviewAttachment}>
          <div className={styles.filePreviewMain}>
            <NavigationItem
              aria-label={`Preview ${displayName}`}
              icon={
                <span className={fileIconStyles.slot}>
                  <FileTypeIcon name={attachment.name} mime={attachment.mime} />
                </span>
              }
              label={
                <span className={styles.fileAttachmentBody}>
                  <span
                    className={styles.fileAttachmentName}
                    title={displayName}
                  >
                    {displayName}
                  </span>
                  <span className={styles.fileAttachmentMeta}>
                    {state === "pending" ? (
                      "Downloading…"
                    ) : state === "saved" ? (
                      "Saved to Downloads"
                    ) : state === "failed" ? (
                      "Couldn’t download · Retry"
                    ) : (
                      <>
                        {typeLabel ?? mimeLabel(attachment.mime) ?? "File"}
                        {attachment.size !== undefined &&
                          ` · ${formatFileSize(attachment.size)}`}
                      </>
                    )}
                  </span>
                </span>
              }
              onClick={onPreview}
            />
          </div>
          <span className={styles.fileDownloadAction}>
            {nativeSource ? (
              <IconButton
                {...action}
                loading={state === "pending"}
                onClick={() => void download?.()}
              />
            ) : (
              <IconButton
                {...action}
                nativeButton={false}
                role="link"
                render={<a href={source} download={attachment.name ?? ""} />}
              />
            )}
          </span>
        </div>
      );
    };
    return nativeSource ? (
      <NativeDownloadAction
        key={JSON.stringify([source, attachment.name])}
        source={source}
        name={attachment.name ?? ""}
        displayName={displayName}
      >
        {renderPreview}
      </NativeDownloadAction>
    ) : (
      renderPreview()
    );
  }

  const content = (state: FileCardState = "idle") => (
    <>
      <span className={fileIconStyles.slot}>
        <FileTypeIcon name={attachment.name} mime={attachment.mime} />
      </span>
      <span className={styles.fileAttachmentBody}>
        <span className={styles.fileAttachmentName}>{displayName}</span>
        <span className={styles.fileAttachmentMeta}>
          {state === "pending"
            ? "Downloading…"
            : state === "ready"
              ? attachment.size
                ? `${formatFileSize(attachment.size)} · Downloaded`
                : "Downloaded"
              : state === "moved"
                ? "Moved or changed · Download again"
                : state === "openFailed"
                  ? "Couldn’t open · Try again"
                  : state === "failed"
                    ? "Couldn’t download · Retry"
                    : source
                      ? attachment.size
                        ? formatFileSize(attachment.size)
                        : proxySource
                          ? "Download file"
                          : "Open file"
                      : "File unavailable"}
        </span>
      </span>
      {state === "pending" ? (
        <CircleNotchIcon
          size={20}
          className="motion-safe:animate-spin"
          aria-hidden="true"
        />
      ) : state === "failed" || state === "openFailed" ? (
        <ArrowsClockwiseIcon size={20} aria-hidden="true" />
      ) : proxySource && state !== "ready" ? (
        <DownloadIcon size={20} aria-hidden="true" />
      ) : (
        <ArrowUpRightIcon size={20} aria-hidden="true" />
      )}
    </>
  );
  if (!source)
    return (
      <UnavailableFileAttachment
        displayName={displayName}
        attachment={attachment}
      />
    );
  if (externalSource)
    return (
      <a
        className={styles.fileAttachment}
        href={source}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${displayName}`}
        title={displayName}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          if (onOpenLink(source)) event.preventDefault();
        }}
      >
        {content()}
      </a>
    );
  if (nativeSource)
    return (
      <NativeFileDownload
        key={JSON.stringify([source, attachment.name])}
        source={source}
        name={attachment.name ?? ""}
        displayName={displayName}
      >
        {content}
      </NativeFileDownload>
    );
  return (
    <a
      className={styles.fileAttachment}
      href={source}
      download={attachment.name ?? ""}
      aria-label={`Download ${displayName}`}
      title={displayName}
    >
      {content()}
    </a>
  );
}

/** The download action beside a preview card: a source/name change mounts a
 * fresh download lifetime, retiring old results. */
function NativeDownloadAction({
  source,
  name,
  displayName,
  children,
}: {
  source: string;
  name: string;
  displayName: string;
  children(state: DownloadState, download: () => Promise<void>): ReactNode;
}) {
  const { state, download } = useNativeDownload(source, name);
  const announcement =
    state === "pending"
      ? `Downloading ${displayName}`
      : state === "saved"
        ? `Saved ${displayName} to Downloads`
        : state === "failed"
          ? `Couldn’t download ${displayName}. Try again.`
          : "";
  return (
    <>
      {children(state, download)}
      <span className="sr-only" role={state === "failed" ? "alert" : "status"}>
        {announcement}
      </span>
    </>
  );
}

/** A source/name change mounts a fresh download lifetime, retiring old results.
 * The host remembers where it saved the file; once saved, a click opens that
 * copy and the context menu shows it in its folder or downloads it again. */
function NativeFileDownload({
  source,
  name,
  displayName,
  children,
}: {
  source: string;
  name: string;
  displayName: string;
  children(state: FileCardState): ReactNode;
}) {
  const [state, setState] = useState<FileCardState>("idle");
  // Only this card's own actions are announced, never a status found on mount.
  const [notice, setNotice] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement>();
  const trigger = useRef<HTMLButtonElement>(null);
  // A status asked before the latest action, or answered after unmount, is stale.
  const generation = useRef(0);
  const busy = useRef(false);
  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      const asked = generation.current;
      savedDownloadStatus(source, name).then(
        (saved) => {
          if (!mounted || asked !== generation.current) return;
          setState((current) =>
            saved ? "ready" : current === "ready" ? "idle" : current,
          );
        },
        () => {},
      );
    };
    refresh();
    const stop = subscribeSavedDownloads(refresh);
    return () => {
      mounted = false;
      stop();
    };
  }, [source, name]);
  const run = async (action: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    generation.current += 1;
    try {
      await action();
    } finally {
      busy.current = false;
    }
  };
  const download = () =>
    run(async () => {
      setState("pending");
      setNotice(`Downloading ${displayName}`);
      try {
        await downloadNativeMedia(source, name);
        setState("ready");
        setNotice(`Saved ${displayName} to Downloads`);
      } catch {
        setState("failed");
        setNotice(`Couldn’t download ${displayName}. Try again.`);
      }
    });
  const open = (reveal: boolean) =>
    run(async () => {
      try {
        if ((await openSavedDownload(source, name, reveal)) === "moved") {
          setState("moved");
          setNotice(`${displayName} was moved or changed. Download it again.`);
        } else setState("ready");
      } catch {
        setState("openFailed");
        setNotice(`Couldn’t open ${displayName}. Try again.`);
      }
    });
  const saved = state === "ready" || state === "openFailed";
  const alert =
    state === "failed" || state === "moved" || state === "openFailed";
  return (
    <ContextMenuRoot
      open={menuOpen}
      onOpenChange={setMenuOpen}
      disabled={!saved}
    >
      <ContextMenuTrigger
        render={
          <button
            ref={trigger}
            type="button"
            className={styles.fileAttachment}
            aria-label={`${state === "failed" ? "Retry download" : saved ? "Open" : "Download"} ${displayName}`}
            aria-disabled={state === "pending"}
            aria-busy={state === "pending"}
            title={displayName}
            onClick={() => void (saved ? open(false) : download())}
          >
            {children(state)}
          </button>
        }
        onContextMenu={() => setMenuAnchor(undefined)}
        onTouchStart={() => setMenuAnchor(undefined)}
        onKeyDown={(event) => {
          if (
            saved &&
            (event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10"))
          ) {
            event.preventDefault();
            setMenuAnchor(trigger.current ?? undefined);
            setMenuOpen(true);
          }
        }}
      />
      <span className="sr-only" role={alert ? "alert" : "status"}>
        {notice}
      </span>
      <MenuPopup size="compact" anchor={menuAnchor} finalFocus={trigger}>
        <MenuItem onClick={() => void open(false)}>
          <MenuIcon>
            <ArrowUpRightIcon size={16} />
          </MenuIcon>
          Open
        </MenuItem>
        <MenuItem onClick={() => void open(true)}>
          <MenuIcon>
            <FolderOpenIcon size={16} />
          </MenuIcon>
          {isApplePlatform(navigator.platform)
            ? "Show in Finder"
            : "Show in folder"}
        </MenuItem>
        <MenuItem onClick={() => void download()}>
          <MenuIcon>
            <DownloadIcon size={16} />
          </MenuIcon>
          Download again
        </MenuItem>
      </MenuPopup>
    </ContextMenuRoot>
  );
}

function UnavailableFileAttachment({
  displayName,
  attachment,
}: {
  displayName: string;
  attachment: Attachment;
}) {
  return (
    <span className={styles.fileAttachment} role="status" title={displayName}>
      <span className={fileIconStyles.slot}>
        <FileTypeIcon name={attachment.name} mime={attachment.mime} />
      </span>
      <span className={styles.fileAttachmentBody}>
        <span className={styles.fileAttachmentName}>{displayName}</span>
        <span className={styles.fileAttachmentMeta}>File unavailable</span>
      </span>
    </span>
  );
}

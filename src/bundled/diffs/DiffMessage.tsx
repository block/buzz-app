import { DetailTabContext } from "../../features/messages/DetailTabContext";
import { useComposerScope } from "../../features/messages/composer-overlay";
import {
  RowKeepAlive,
  useInlineContainers,
  useReaderSlot,
  useRequestedReader,
} from "../../features/messages/inline-containers";
import {
  type ComponentProps,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { ChannelMessage } from "../../features/relay/contracts";
import { safeMessageUrl } from "../../features/relay/message-content";
import { ArrowsOutIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { DiffViewer } from "./DiffViewer";
import { parsePatch } from "./parse";
import styles from "./Diffs.module.css";

/** The expanded diff, with its own layout choice: each sheet or tab that
 * shows it starts unified. */
function DiffReader({
  viewer,
  warning,
}: {
  viewer: Omit<ComponentProps<typeof DiffViewer>, "viewType">;
  warning: ReactNode;
}) {
  const [viewType, setViewType] = useState<"unified" | "split">("unified");
  return (
    <>
      <fieldset className={styles.toolbar} aria-label="Diff layout">
        <Button
          size="sm"
          aria-pressed={viewType === "unified"}
          variant={viewType === "unified" ? "subtle" : "ghost"}
          onClick={() => setViewType("unified")}
        >
          Unified
        </Button>
        <Button
          size="sm"
          aria-pressed={viewType === "split"}
          variant={viewType === "split" ? "subtle" : "ghost"}
          onClick={() => setViewType("split")}
        >
          Split
        </Button>
      </fieldset>
      {warning}
      <DiffViewer {...viewer} viewType={viewType} />
    </>
  );
}

export function DiffMessage({ message }: { message: ChannelMessage }) {
  const tabs = useContext(DetailTabContext);
  const { opener, dialogs } = useInlineContainers();
  const composer = useComposerScope();
  const target = { kind: "diff", messageId: message.id } as const;
  const slot = useReaderSlot(composer, target);
  const keepMounted = useContext(RowKeepAlive);
  const open = !!slot;
  // Its reader is drawn from this row: it stays mounted while it reads.
  useEffect(() => (open ? keepMounted?.() : undefined), [open, keepMounted]);
  const expand = useRef<HTMLButtonElement>(null);
  const files = useMemo(() => parsePatch(message.content), [message.content]);
  const show = useRef<() => void>(undefined);
  useRequestedReader(opener, target, () => show.current?.());
  const meta = message.diff;
  if (!meta) return null;
  const repoUrl = meta.repoUrl ? safeMessageUrl(meta.repoUrl) : undefined;
  const commit = meta.commitSha;
  const commitUrl =
    repoUrl && commit && /^[0-9a-f]{7,64}$/i.test(commit)
      ? `${repoUrl.replace(/\/$/, "")}/commit/${commit}`
      : undefined;
  const source = commitUrl || repoUrl;
  const title = meta.filePath || "Diff";
  const viewer = { content: message.content, files, filePath: meta.filePath };
  const warning = meta.truncated && (
    <p className={styles.notice}>
      Diff truncated.{" "}
      {source ? (
        <a href={source} target="_blank" rel="noreferrer noopener">
          View full diff at the source repository
        </a>
      ) : (
        "View the full diff at the source repository."
      )}
    </p>
  );
  const reader = <DiffReader viewer={viewer} warning={warning} />;
  show.current = () =>
    opener.open({
      target,
      composer,
      trigger: expand.current,
      // A diff already in a tab shows there, as it was left.
      hasTab: tabs?.has(`diff:${message.id}`),
      openAsTab:
        tabs &&
        (() =>
          tabs.open({
            id: `diff:${message.id}`,
            title,
            content: reader,
          })),
    });
  return (
    <>
      <section className={styles.card} aria-label={`Diff: ${title}`}>
        <header className={styles.header}>
          <span className={styles.filename} title={title}>
            {title}
          </span>
          <span className={styles.source}>
            {source ? (
              <a href={source} target="_blank" rel="noreferrer noopener">
                {commit?.slice(0, 7) || "Source"}
              </a>
            ) : (
              commit?.slice(0, 7)
            )}
          </span>
          <IconButton
            ref={expand}
            size="sm"
            aria-label="Expand diff"
            icon={<ArrowsOutIcon size={16} aria-hidden="true" />}
            onClick={() => show.current?.()}
          />
        </header>
        {meta.description && (
          <p className={styles.description}>{meta.description}</p>
        )}
        <section
          className={styles.preview}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The preview scroll owner must support keyboard scrolling.
          tabIndex={0}
          aria-label={`Diff preview: ${title}`}
        >
          <DiffViewer {...viewer} />
        </section>
        {warning}
      </section>
      {slot?.title && createPortal(title, slot.title)}
      {slot?.body && createPortal(reader, slot.body)}
      {dialogs}
    </>
  );
}

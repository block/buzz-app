import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PanelProps } from "../../features/panels/service";
import { FileAttachment } from "../../features/messages/FileAttachment";
import {
  safeLinkUrl,
  scanMarkdown,
} from "../../features/relay/message-content";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { Button } from "../../shared/design-system/ui/Button";
import messageStyles from "../../features/messages/Messages.module.css";
import styles from "./FilePreview.module.css";
import { loadPreview, parsePreviewTarget } from "./preview";

type PreviewState =
  | { kind: "loading" }
  | { kind: "ready"; text: string }
  | { kind: "error"; message: string }
  | { kind: "retrying"; message: string };

export function FilePreviewPanel({ target, context }: PanelProps) {
  const file = parsePreviewTarget(target);
  return file ? (
    <Preview key={target} file={file} open={context?.open ?? (() => false)} />
  ) : (
    <p role="alert">This file cannot be previewed.</p>
  );
}

function Preview({
  file,
  open,
}: {
  file: NonNullable<ReturnType<typeof parsePreviewTarget>>;
  open(target: string): boolean;
}) {
  const [state, setState] = useState<PreviewState>({ kind: "loading" });
  const [attempt, retry] = useState(0);
  const region = useRef<HTMLElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the explicit user-requested retry trigger.
  useEffect(() => {
    const controller = new AbortController();
    void loadPreview(
      file.source,
      AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    ).then(
      (text) => {
        if (controller.signal.aborted) return;
        if (retryButton.current === document.activeElement)
          region.current?.focus({ preventScroll: true });
        setState({ kind: "ready", text });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            kind: "error",
            message:
              error instanceof Error
                ? error.message
                : "The file could not be loaded. Try again.",
          });
      },
    );
    return () => controller.abort();
  }, [file.source, attempt]);
  return (
    <section
      ref={region}
      tabIndex={-1}
      className={styles.content}
      aria-label={`Preview: ${file.attachment.name ?? "file"}`}
    >
      <FileAttachment
        variant="summary"
        attachment={file.attachment}
        source={file.source}
        onOpenLink={open}
        typeLabel={file.format === "markdown" ? "Markdown" : "Plain text"}
      />
      <LoadingRegion
        pending={state.kind === "loading" || state.kind === "retrying"}
        label="Loading preview…"
      >
        {state.kind === "loading" ? null : state.kind === "error" ||
          state.kind === "retrying" ? (
          <div role="alert">
            <p>{state.message}</p>
            <Button
              ref={retryButton}
              size="sm"
              loading={state.kind === "retrying"}
              onClick={() => {
                setState({ kind: "retrying", message: state.message });
                retry((attempt) => attempt + 1);
              }}
            >
              Retry
            </Button>
          </div>
        ) : !state.text ? (
          <p role="status">This file is empty.</p>
        ) : file.format === "markdown" && !scanMarkdown(state.text).tooDeep ? (
          <div className={messageStyles.text}>
            <Markdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              urlTransform={(url) => safeLinkUrl(url) ?? ""}
              components={{
                a: ({ href, children }) =>
                  href ? (
                    <a href={href} target="_blank" rel="noreferrer">
                      {children}
                    </a>
                  ) : (
                    children
                  ),
                img: ({ alt }) => <span>{alt || "Image"} (image omitted)</span>,
              }}
            >
              {state.text}
            </Markdown>
          </div>
        ) : (
          <pre className={styles.text}>{state.text}</pre>
        )}
      </LoadingRegion>
    </section>
  );
}

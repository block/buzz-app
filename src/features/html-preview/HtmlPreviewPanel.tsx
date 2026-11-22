import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { WarningCircleIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import type { Browser } from "../browser/api";
import { usePanelTabTitle } from "../panels/PanelWorkspace";
import { parseHtmlPreviewTarget } from "./target";

export type PrepareHtmlPreview = (
  source: string,
  name: string,
) => Promise<string>;

const defaultPrepare: PrepareHtmlPreview = (source, name) =>
  invoke<string>("media_html_preview_url", { source, name });

export function HtmlPreviewPanel({
  target,
  origins,
  View,
  preparePreview = defaultPrepare,
}: {
  target: string;
  origins(): ReadonlySet<string>;
  View: Browser["View"];
  preparePreview?: PrepareHtmlPreview | undefined;
}) {
  const parsed = parseHtmlPreviewTarget(target, origins());
  const label = parsed?.label ?? "HTML preview";
  usePanelTabTitle(label);

  const [previewUrl, setPreviewUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  const source = parsed?.source;
  const name = parsed?.name ?? "";
  const fragment = parsed?.fragment ?? "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: Try again increments `attempt` to re-run preparation.
  useEffect(() => {
    if (!source) {
      setPreviewUrl(undefined);
      setError("This HTML link is not from a community you belong to.");
      return;
    }
    let cancelled = false;
    setPreviewUrl(undefined);
    setError(undefined);
    preparePreview(source, name).then(
      (base) => {
        if (cancelled) return;
        const withoutHash = base.split("#", 1)[0] ?? base;
        setPreviewUrl(`${withoutHash}${fragment}`);
      },
      (reason: unknown) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source, name, fragment, preparePreview, attempt]);

  if (error)
    return (
      <div role="alert" className="page-status">
        <EmptyState
          icon={<WarningCircleIcon />}
          title="Buzz couldn’t open this HTML file"
          description={error}
          action={
            source ? (
              <Button
                type="button"
                variant="primary"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Try again
              </Button>
            ) : undefined
          }
        />
      </div>
    );

  if (!previewUrl)
    return (
      <div className="page-status">
        <LoadingRegion pending label="Opening preview…">
          {null}
        </LoadingRegion>
      </div>
    );

  return <View url={previewUrl} label={label} allowOpenExternal />;
}

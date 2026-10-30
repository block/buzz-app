import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Button } from "../shared/design-system/ui/Button";
import { Dialog } from "../shared/design-system/ui/Dialog";
import { InlineHeader } from "../shared/design-system/ui/Header";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { Switch } from "../shared/design-system/ui/Switch";
import type { PluginManager } from "../plugins/manager";
import type {
  Catalog,
  ImportPreview,
  ManagedEntry,
  ManagedPlugins as ManagedPolicy,
} from "../plugins/types";
import { PluginAccessReview } from "./PluginAccessReview";
import importStyles from "./PluginImport.module.css";
import styles from "./Settings.module.css";

type Authorize = (
  repository: string,
) => Promise<{ repository: string; token: string } | null>;

const location = ({ repository, reference, path }: ManagedEntry) =>
  [repository, reference, ...(path === "." ? [] : [path])].join(" · ");

export function ManagedPlugins({
  plugins,
  managed,
  catalog,
  busy,
  authorizeGit,
}: {
  plugins: PluginManager;
  managed: ManagedPolicy | undefined;
  catalog: Catalog;
  busy: boolean;
  authorizeGit?: Authorize | undefined;
}) {
  const [reviewing, setReviewing] = useState<ManagedEntry>();
  const trigger = useRef<HTMLElement | null>(null);
  if (!plugins.imports || !managed) return null;
  if (managed.status === "invalid")
    return (
      <section
        aria-labelledby="managed-plugins-title"
        className={styles.pluginCoreSection}
      >
        <InlineHeader
          id="managed-plugins-title"
          title="Recommended plugins unavailable"
        />
        <p role="status" className="m-0 text-body-sm text-muted break-words">
          Buzz couldn’t use the managed plugin file {managed.path}.{" "}
          {managed.reason}
        </p>
      </section>
    );
  const rows = managed.plugins.filter(({ state }) => state !== "current");
  if (!rows.length && !managed.problems.length) return null;
  return (
    <section
      aria-labelledby="managed-plugins-title"
      className={styles.pluginCoreSection}
    >
      <InlineHeader
        id="managed-plugins-title"
        title={
          rows.length
            ? `Recommended by ${managed.source}`
            : "Recommended plugins"
        }
      />
      {rows.length > 0 && (
        <SettingsGroup>
          {rows.map((entry) => (
            <PreferenceRow
              key={entry.id}
              title={entry.id}
              subtitle={
                entry.state === "other"
                  ? `Installed from a different source. Remove it to review the recommended version. ${location(entry)}`
                  : `${entry.state === "outdated" ? "Update recommended. " : ""}${location(entry)}`
              }
              trailing={
                entry.state === "other" ? undefined : (
                  <Button
                    size="sm"
                    variant={entry.state === "missing" ? "prominent" : "subtle"}
                    disabled={busy}
                    aria-label={`${entry.state === "missing" ? "Review and install" : "Review update"} ${entry.id}`}
                    onClick={(event) => {
                      trigger.current = event.currentTarget;
                      setReviewing(entry);
                    }}
                  >
                    {entry.state === "missing"
                      ? "Review and install"
                      : "Review update"}
                  </Button>
                )
              }
            />
          ))}
        </SettingsGroup>
      )}
      {managed.problems.length > 0 && (
        <div role="status" className="mt-3 text-body-sm text-muted">
          <p className="m-0">
            Some entries in the managed plugin file were ignored:
          </p>
          <ul className="mb-0 mt-1 list-disc space-y-1 break-words pl-4">
            {managed.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      {reviewing && (
        <ManagedPluginReview
          plugins={plugins}
          catalog={catalog}
          busy={busy}
          source={managed.source}
          entry={reviewing}
          authorizeGit={authorizeGit}
          returnFocus={() => trigger.current}
          onClose={() => setReviewing(undefined)}
        />
      )}
    </section>
  );
}

type Review =
  | { status: "loading" }
  | { status: "error"; reason: string }
  | { status: "ready"; preview: ImportPreview; path: string };

function ManagedPluginReview({
  plugins,
  catalog,
  busy: managing,
  source,
  entry,
  authorizeGit,
  returnFocus,
  onClose,
}: {
  plugins: PluginManager;
  catalog: Catalog;
  busy: boolean;
  source: string;
  entry: ManagedEntry;
  authorizeGit?: Authorize | undefined;
  returnFocus: () => HTMLElement | null;
  onClose: () => void;
}) {
  const imports = plugins.imports;
  const [attempt, setAttempt] = useState(0);
  const [review, setReview] = useState<Review>({ status: "loading" });
  const [installing, setInstalling] = useState(false);
  const [enable, setEnable] = useState(true);
  // Snapshot at open: installing refreshes the catalog before enabling.
  const [existing] = useState(() =>
    catalog.plugins.find((plugin) => plugin.manifest.id === entry.id),
  );
  const token = useRef("");
  const discard = (value: string) =>
    void imports?.discard(value).catch(() => {});
  const acquire = useEffectEvent(async (current: { active: boolean }) => {
    if (!imports) return;
    try {
      const signed = await authorizeGit?.(entry.repository);
      const preview = await imports.git(
        signed?.repository ?? entry.repository,
        entry.reference,
        signed?.token,
        entry.commit,
      );
      if (!preview) throw new Error("No plugin source found.");
      if (!current.active) {
        discard(preview.token);
        return;
      }
      const candidate = preview.candidates.find(
        (item) => item.path === entry.path,
      );
      if (candidate?.manifest.id === entry.id) {
        token.current = preview.token;
        setReview({ status: "ready", preview, path: entry.path });
        return;
      }
      discard(preview.token);
      const prefix = entry.path === "." ? "Selected folder:" : `${entry.path}:`;
      throw new Error(
        candidate
          ? `The plugin at ${entry.path} is ${candidate.manifest.id}, not ${entry.id}.`
          : (preview.warnings.find((warning) => warning.startsWith(prefix)) ??
              `This commit has no plugin at ${entry.path}.`),
      );
    } catch (reason) {
      if (current.active)
        setReview({
          status: "error",
          reason: reason instanceof Error ? reason.message : String(reason),
        });
    }
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: a retry is a new attempt for the same entry.
  useEffect(() => {
    const current = { active: true };
    setReview({ status: "loading" });
    // Deferred so Strict Mode's retired mount never acquires the import slot.
    queueMicrotask(() => {
      if (current.active) void acquire(current);
    });
    return () => {
      current.active = false;
      if (token.current) discard(token.current);
      token.current = "";
    };
  }, [attempt]);

  const candidate =
    review.status === "ready"
      ? review.preview.candidates.find((item) => item.path === review.path)
      : undefined;
  const updating = !!existing;

  async function install() {
    if (!candidate || review.status !== "ready" || installing) return;
    setInstalling(true);
    const value = review.preview.token;
    try {
      const success = await plugins.installImport(value, candidate.path);
      if (!success) {
        setReview({
          status: "error",
          reason:
            plugins.snapshot().error ??
            "Plugin installation wasn’t confirmed. Check the preview and try again.",
        });
        return;
      }
      token.current = "";
      await imports?.discard(value).catch(() => {});
      if (!updating && enable) await plugins.change("enable", entry.id);
      onClose();
    } finally {
      setInstalling(false);
    }
  }

  const busy = installing || managing || review.status === "loading";
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={
        review.status === "ready"
          ? updating
            ? `Update ${candidate?.manifest.name ?? entry.id}`
            : "Review plugin access"
          : `Review ${entry.id}`
      }
      description={
        review.status === "ready" && !updating
          ? `Recommended by ${source}. Only install code you trust.`
          : undefined
      }
      size={review.status === "ready" && updating ? "compact" : "wide"}
      preventClose={installing}
      dismissOnOutsideClick
      finalFocus={returnFocus}
      leadingActions={
        review.status === "ready" && !updating ? (
          <Switch
            label="Enable plugin"
            checked={enable}
            disabled={busy}
            onCheckedChange={setEnable}
          />
        ) : review.status === "ready" && existing?.enabled === false ? (
          <p className="m-0 text-body-sm text-muted">
            This plugin will stay disabled.
          </p>
        ) : undefined
      }
      actions={
        <>
          {review.status === "error" && (
            <Button onClick={() => setAttempt((count) => count + 1)}>
              Try again
            </Button>
          )}
          <Button disabled={installing} onClick={onClose}>
            {review.status === "ready" ? "Cancel" : "Close"}
          </Button>
          {review.status === "ready" && (
            <Button
              variant="prominent"
              disabled={busy}
              loading={installing}
              onClick={() => void install()}
            >
              {updating ? "Update" : "Install plugin"}
            </Button>
          )}
        </>
      }
    >
      {review.status === "loading" && (
        <p role="status">
          Reading the plugin at the pinned commit… Git imports may take up to a
          minute.
        </p>
      )}
      {review.status === "error" && (
        <p role="alert" className="error break-words">
          {review.reason}
        </p>
      )}
      {review.status === "ready" && candidate && (
        <section aria-label="Managed plugin source" className="text-body-sm">
          <code className={`${importStyles.sourcePath} break-all`}>
            {location(entry)}
          </code>
          <p className="mb-4 mt-1 break-all text-caption text-muted">
            Commit: {review.preview.commit}
          </p>
          <PluginAccessReview
            manifest={candidate.manifest}
            previousManifest={existing?.manifest}
          />
        </section>
      )}
    </Dialog>
  );
}

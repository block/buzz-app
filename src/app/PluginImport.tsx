import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { Field } from "../shared/design-system/ui/Field";
import { Input } from "../shared/design-system/ui/Input";
import { Radio, RadioGroup } from "../shared/design-system/ui/RadioGroup";
import { Button } from "../shared/design-system/ui/Button";
import { Dialog } from "../shared/design-system/ui/Dialog";
import { readPluginFolder } from "./plugin-folder-drop";
import styles from "./PluginImport.module.css";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FolderOpenIcon } from "../shared/design-system/icons/index";
import type { PluginManager } from "../plugins/manager";
import type { Catalog, ImportPreview } from "../plugins/types";
import type { PluginManifest } from "../plugins/api";

function hostGrants(manifest: PluginManifest): string[] {
  return [
    ...(manifest.host?.commands ?? []).map(
      (command) =>
        `Command ${command.id}: ${JSON.stringify([command.program, ...command.args])} · input: ${command.maxInputBytes === undefined ? "none" : `up to ${command.maxInputBytes} bytes`} · output: up to ${command.maxOutputBytes ?? 4096} bytes`,
    ),
    ...(manifest.host?.networkOrigins ?? []).map(
      (origin) => `HTTPS origin: ${origin}`,
    ),
    ...(manifest.host?.processes ?? []).map(
      (process) =>
        `Process ${process.id}: ${JSON.stringify([process.program, ...(process.args ?? [])])}${process.bundled ? " (bundled with Buzz)" : ""} and any further arguments · stdin, full user access`,
    ),
    ...(manifest.host?.mcp
      ? ["MCP servers: tools served to local agents over loopback HTTP"]
      : []),
  ];
}

function contentChange(
  name: string,
  next: string | null | undefined,
  previous: string | null | undefined,
  updating: boolean,
) {
  if (!updating) return next ? `${name} included` : null;
  if (!next) return previous ? `${name} removed` : null;
  if (!previous) return `${name} included (new)`;
  return `${name} included (${next === previous ? "unchanged" : "changed"})`;
}

export function PluginImport({
  plugins,
  catalog,
  busy,
  authorizeGit,
  actionTarget,
}: {
  plugins: PluginManager;
  catalog: Catalog;
  busy: boolean;
  actionTarget?: HTMLElement | null;
  /** Signs in to the selected community's Buzz git; null for other repositories. */
  authorizeGit?: (
    repository: string,
  ) => Promise<{ repository: string; token: string } | null>;
}) {
  const imports = plugins.imports;
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [repository, setRepository] = useState("");
  const [reference, setReference] = useState("");
  const [loading, setLoading] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lifetime = useRef({ active: true, token: "" });
  const pending = useRef(false);
  useEffect(() => {
    const current = { active: true, token: "" };
    lifetime.current = current;
    return () => {
      current.active = false;
      if (current.token) void imports?.discard(current.token).catch(() => {});
    };
  }, [imports]);

  const blocked = busy || loading || discarding;
  if (!imports) return null;

  async function load(operation: () => Promise<ImportPreview | null>) {
    if (pending.current || blocked) return;
    pending.current = true;
    const current = lifetime.current;
    setLoading(true);
    setError(null);
    setNotice(null);
    setPreview(null);
    try {
      const next = await operation();
      if (!current.active) {
        if (next) await imports?.discard(next.token);
        return;
      }
      current.token = next?.token ?? "";
      setPreview(next);
      setSelected(
        next?.candidates.length === 1 ? (next.candidates[0]?.path ?? "") : "",
      );
    } catch (reason) {
      if (current.active) setError(String(reason));
    } finally {
      pending.current = false;
      if (current.active) setLoading(false);
    }
  }
  async function dismiss() {
    if (blocked || pending.current || !preview) return;
    pending.current = true;
    setDiscarding(true);
    try {
      await imports?.discard(preview.token);
      lifetime.current.token = "";
      setPreview(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      pending.current = false;
      setDiscarding(false);
    }
  }
  async function close() {
    if (blocked || pending.current) return;
    pending.current = true;
    setDiscarding(true);
    try {
      if (lifetime.current.token)
        await imports?.discard(lifetime.current.token);
      lifetime.current.token = "";
      setPreview(null);
      setError(null);
      setNotice(null);
      setDragging(false);
      setOpen(false);
    } catch (reason) {
      setError(String(reason));
    } finally {
      pending.current = false;
      setDiscarding(false);
    }
  }
  const candidate = preview?.candidates.find((p) => p.path === selected);
  const existing = catalog.plugins.find(
    (p) => p.manifest.id === candidate?.manifest.id,
  );
  const rollbackNotice =
    candidate?.publisher && existing && !existing.hasSignature
      ? "You cannot roll back to the unsigned revision after this update."
      : candidate?.revision === existing?.revision &&
          existing?.rollbackBlockedReason
        ? `${existing.rollbackBlockedReason}.`
        : existing?.previous || existing?.revision !== candidate?.revision
          ? "You can still roll back."
          : "There is no earlier revision to roll back to.";
  const declaredGrants = candidate ? hostGrants(candidate.manifest) : [];
  const previousGrants = existing ? hostGrants(existing.manifest) : [];
  const packageContent = candidate
    ? [
        contentChange(
          "README.md",
          candidate.readmeRevision,
          existing?.readmeRevision,
          !!existing,
        ),
        contentChange(
          "icon.png",
          candidate.iconPngRevision,
          existing?.iconPngRevision,
          !!existing,
        ),
        contentChange(
          "icon.jpg",
          candidate.iconJpgRevision,
          existing?.iconJpgRevision,
          !!existing,
        ),
      ].filter((value) => value !== null)
    : [];
  const addButton = (
    <Button
      ref={trigger}
      size="sm"
      disabled={blocked}
      onClick={() => setOpen(true)}
    >
      Add
    </Button>
  );
  return (
    <>
      {actionTarget ? createPortal(addButton, actionTarget) : addButton}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) void close();
        }}
        title="Add a plugin"
        description="Load built plugins containing manifest.json and plugin.js. Buzz doesn’t build source code or run install scripts. Only load code you trust: plugins aren’t sandboxed."
        size="wide"
        dismissOnOutsideClick
        preventClose={blocked}
        finalFocus={trigger}
      >
        <div className={styles.columns}>
          <section
            aria-label="Add from folder"
            className={styles.folder}
            data-dragging={dragging || undefined}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = blocked ? "none" : "copy";
              setDragging(!blocked);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setDragging(false);
              const items = Array.from(event.dataTransfer.items);
              const entry =
                items.length === 1 ? items[0]?.webkitGetAsEntry?.() : null;
              const current = lifetime.current;
              void load(async () => {
                if (!entry?.isDirectory)
                  throw new Error("Drop one folder, or choose Browse.");
                const upload = await readPluginFolder(entry);
                if (!current.active) return null;
                const next = await imports.files(upload.source, upload.files);
                return next
                  ? {
                      ...next,
                      warnings: [...upload.warnings, ...next.warnings],
                    }
                  : null;
              });
            }}
          >
            <FolderOpenIcon size={32} aria-hidden="true" />
            <p className="m-0 text-body-sm">Drop a plugin folder here</p>
            <Button
              size="sm"
              aria-label="Browse plugin folder"
              disabled={blocked}
              onClick={() => void load(imports.folder)}
            >
              Browse
            </Button>
          </section>
          <form
            aria-label="Add from Git"
            className={styles.git}
            onSubmit={(event) => {
              event.preventDefault();
              if (repository.trim())
                void load(async () => {
                  const signed = await authorizeGit?.(repository);
                  return signed
                    ? imports.git(signed.repository, reference, signed.token)
                    : imports.git(repository, reference);
                });
            }}
          >
            <SettingsGroup layout="form">
              <Field label="Git or GitHub repository">
                <Input
                  required
                  value={repository}
                  disabled={blocked}
                  placeholder="https://github.com/owner/repository"
                  onChange={(event) => setRepository(event.target.value)}
                />
              </Field>
              <Field label="Branch or tag (optional)">
                <Input
                  value={reference}
                  disabled={blocked}
                  placeholder="Repository default"
                  onChange={(event) => setReference(event.target.value)}
                />
              </Field>
              <p className="m-0 text-caption text-muted">
                HTTPS or SSH; GitHub owner/repository also works. SSH uses your
                agent and known hosts. Password prompts and credential helpers
                are not used. Buzz git repositories in this community sign in
                with your account.
              </p>
              <div className="justify-self-start">
                <Button
                  type="submit"
                  size="sm"
                  aria-label="Find plugins"
                  disabled={blocked || !repository.trim()}
                >
                  Find
                </Button>
              </div>
            </SettingsGroup>
          </form>
        </div>
        {loading && (
          <p role="status">
            Reading plugin folders… Git imports may take up to a minute.
          </p>
        )}
        {error && (
          <p role="alert" className="error break-words">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {preview && (
          <section aria-label="Plugin import preview" className="mt-4">
            <SettingsGroup layout="form">
              <div className="min-w-0 text-body-sm">
                <p className="m-0 break-all font-medium">{preview.source}</p>
                {preview.commit && (
                  <p className="m-0 break-all text-caption text-muted">
                    Commit: {preview.commit}
                  </p>
                )}
              </div>
              {preview.candidates.length === 0 ? (
                <p className="m-0">
                  No built plugins found. Build the plugin first, then choose
                  its output folder, or use a repository that includes built
                  artifacts.
                </p>
              ) : (
                <Field label="Choose a plugin folder">
                  <RadioGroup
                    name="plugin-folder"
                    value={selected}
                    disabled={busy}
                    onValueChange={(value) => {
                      setSelected(value);
                      setNotice(null);
                    }}
                  >
                    {preview.candidates.map((item) => (
                      <Radio
                        key={item.path}
                        value={item.path}
                        variant="card"
                        label={item.manifest.name}
                        description={
                          <span className="break-all">
                            {item.path} · {item.manifest.id}
                          </span>
                        }
                      />
                    ))}
                  </RadioGroup>
                </Field>
              )}
              {preview.warnings.length > 0 && (
                <details className="text-body-sm text-muted">
                  <summary>Folders skipped ({preview.warnings.length})</summary>
                  <ul className="break-words">
                    {preview.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </details>
              )}
              {packageContent.length > 0 && (
                <section aria-label="Package content" className="text-body-sm">
                  <p className="m-0 font-medium">Package content</p>
                  <ul className="m-0">
                    {packageContent.map((description) => (
                      <li key={description}>{description}</li>
                    ))}
                  </ul>
                  <p className="m-0 text-caption text-muted">
                    Supplied by the plugin publisher; inclusion is not an
                    endorsement by Buzz.
                  </p>
                </section>
              )}
              {candidate && (
                <section
                  aria-label="Declared host access"
                  className="text-body-sm"
                >
                  <p className="m-0 font-medium">Declared host access</p>
                  {declaredGrants.length ? (
                    <ul className="m-0 break-all">
                      {declaredGrants.map((grant) => (
                        <li key={grant}>
                          {grant}
                          {existing && !previousGrants.includes(grant)
                            ? " (new or changed)"
                            : ""}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="m-0">
                      No commands or HTTPS origins declared.
                    </p>
                  )}
                  {existing &&
                    previousGrants.filter(
                      (grant) => !declaredGrants.includes(grant),
                    ).length > 0 && (
                      <p className="m-0 break-all">
                        Removed:{" "}
                        {previousGrants
                          .filter((grant) => !declaredGrants.includes(grant))
                          .join(", ")}
                      </p>
                    )}
                </section>
              )}
              {candidate && (
                <p className="m-0 text-body-sm">
                  {existing
                    ? `This replaces ${existing.manifest.name} (${existing.manifest.id}). ${existing.enabled ? "It stays on and may run immediately unless this launch is in safe mode." : "It stays off."} ${rollbackNotice}`
                    : "This plugin starts off. Turn it on in the list when you’re ready."}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {candidate && (
                  <Button
                    type="button"
                    disabled={blocked}
                    onClick={async () => {
                      const current = lifetime.current;
                      setError(null);
                      setNotice(null);
                      const success = await plugins.installImport(
                        preview.token,
                        candidate.path,
                      );
                      if (!current.active) return;
                      if (success)
                        setNotice(
                          `${candidate.manifest.name} installed. You can choose another folder or close this preview.`,
                        );
                      else
                        setError(
                          plugins.snapshot().error ??
                            "Plugin installation wasn’t confirmed. Check the preview and try again.",
                        );
                    }}
                  >
                    {existing ? "Update plugin" : "Install plugin"}
                  </Button>
                )}
                <Button
                  type="button"
                  disabled={blocked}
                  onClick={() => void dismiss()}
                >
                  Close preview
                </Button>
              </div>
            </SettingsGroup>
          </section>
        )}
      </Dialog>
    </>
  );
}

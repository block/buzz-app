import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { Field } from "../shared/design-system/ui/Field";
import { Input } from "../shared/design-system/ui/Input";
import { Radio, RadioGroup } from "../shared/design-system/ui/RadioGroup";
import { Switch } from "../shared/design-system/ui/Switch";
import { Button } from "../shared/design-system/ui/Button";
import { Accordion } from "../shared/design-system/ui/Accordion";
import { Dialog } from "../shared/design-system/ui/Dialog";
import { readPluginFolder } from "./plugin-folder-drop";
import styles from "./PluginImport.module.css";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  FolderOpenIcon,
  GlobeIcon,
  PlugIcon,
  TerminalWindowIcon,
  MonitorIcon,
} from "../shared/design-system/icons/index";
import type { PluginManager } from "../plugins/manager";
import type { Catalog, ImportPreview, PluginInfo } from "../plugins/types";
import type { PluginManifest } from "../plugins/api";

function importLocation(preview: ImportPreview, path: string | undefined) {
  if (!path || path === ".") return preview.source;
  if (preview.commit) return `${preview.source} · ${path}`;
  const windows = /^(?:[a-z]:\\|\\\\)/i.test(preview.source);
  const separator = windows ? "\\" : "/";
  const source = preview.source.replace(windows ? /\\+$/ : /\/+$/, "");
  return `${source}${separator}${path.replaceAll("/", separator)}`;
}

function ProgramDetails({
  program,
  args,
}: {
  program: string;
  args: readonly string[];
}) {
  return (
    <>
      <p className="mb-2 mt-1">
        Program: <code>{program}</code>
      </p>
      <p className="mb-1 mt-0">Arguments{args.length ? ":" : ": none"}</p>
      {args.length > 0 && (
        <ol className="m-0 list-decimal space-y-2 pl-6">
          {args.map((argument, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: Argument position is its identity; repeated values are valid.
              key={index}
              aria-label={`Argument ${index + 1}`}
            >
              <pre className="m-0 whitespace-pre-wrap break-words">
                <code>{argument}</code>
              </pre>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function hostDeclarations(manifest: PluginManifest) {
  return [
    ...(manifest.host?.commands ?? []).map((command) => ({
      key: `command:${command.id}`,
      signature: `Command ${command.id}: ${JSON.stringify([command.program, ...command.args])} · input: ${command.maxInputBytes === undefined ? "none" : `up to ${command.maxInputBytes} bytes`} · output: up to ${command.maxOutputBytes ?? 4096} bytes`,
      title: `Command ${command.id}:`,
      label: `Run ${command.program}`,
      hint: "Run a program on your computer.",
      icon: TerminalWindowIcon,
      details: (
        <>
          <ProgramDetails program={command.program} args={command.args} />
          <p className="mb-0 mt-2">
            Input:{" "}
            {command.maxInputBytes === undefined
              ? "none"
              : `up to ${command.maxInputBytes} bytes`}
          </p>
          <p className="m-0">
            Output: up to {command.maxOutputBytes ?? 4096} bytes
          </p>
        </>
      ),
    })),
    ...(manifest.host?.networkOrigins ?? []).map((origin) => ({
      key: `origin:${origin}`,
      signature: `HTTPS origin: ${origin}`,
      title: "HTTPS origin:",
      name: `HTTPS origin ${origin}`,
      label: `Connect to ${origin}`,
      hint: "Buzz can make HTTPS requests to this address for the plugin.",
      icon: GlobeIcon,
      details: <code className="break-words">{origin}</code>,
    })),
    ...(manifest.host?.processes ?? []).map((process) => ({
      key: `process:${process.id}`,
      signature: `Process ${process.id}: ${JSON.stringify([process.program, ...(process.args ?? [])])}${process.bundled ? " (bundled with Buzz)" : ""} and any further arguments · stdin, full user access`,
      title: `Process ${process.id}:`,
      label: `Start ${process.program}`,
      hint: "Can start a background process with additional arguments, using your account’s full access.",
      icon: TerminalWindowIcon,
      details: (
        <>
          <ProgramDetails program={process.program} args={process.args ?? []} />
          {process.bundled && <p className="mb-0 mt-2">Bundled with Buzz.</p>}
          <p className="mb-0 mt-2">
            Allows further arguments and standard input, with your account’s
            full access.
          </p>
        </>
      ),
    })),
    ...(manifest.host?.mcp
      ? [
          {
            key: "mcp",
            signature:
              "MCP servers: tools served to local agents over loopback HTTP",
            title: "MCP servers:",
            label: "Provide tools to local agents",
            hint: "Exposes plugin tools through Buzz’s local MCP server.",
            icon: PlugIcon,
            details: (
              <p className="m-0">
                Tools served to local agents over loopback HTTP.
              </p>
            ),
          },
        ]
      : []),
  ];
}

export function PluginImport({
  plugins,
  catalog,
  busy,
  authorizeGit,
  actionTarget,
  updateId,
  onClosed,
  returnFocus,
}: {
  plugins: PluginManager;
  catalog: Catalog;
  busy: boolean;
  actionTarget?: HTMLElement | null;
  updateId?: string;
  onClosed?: () => void;
  returnFocus?: () => HTMLElement | null;
  /** Signs in to the selected community's Buzz git; null for other repositories. */
  authorizeGit?: (
    repository: string,
  ) => Promise<{ repository: string; token: string } | null>;
}) {
  const imports = plugins.imports;
  const [open, setOpen] = useState(!!updateId);
  const [dragging, setDragging] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const savedSource = catalog.plugins.find(
    (item) => item.manifest.id === updateId,
  )?.updateSource;
  const [chooseSource, setChooseSource] = useState(!savedSource);
  const [repository, setRepository] = useState(
    savedSource && "repository" in savedSource ? savedSource.repository : "",
  );
  const [reference, setReference] = useState(
    savedSource && "reference" in savedSource ? savedSource.reference : "",
  );
  // Snapshot at review entry: our own install catalog refresh must not turn a
  // new install into an update while its enable operation is still pending.
  const [existing, setExisting] = useState<PluginInfo>();
  const [loading, setLoading] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selected, setSelected] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const unchangedTrigger = useRef<HTMLButtonElement>(null);
  const unchangedBack = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    (showUnchanged ? unchangedBack.current : unchangedTrigger.current)?.focus();
  }, [showUnchanged]);
  const previewRegion = useRef<HTMLElement>(null);
  const [error, setError] = useState<string | null>(null);
  const browse = useRef<HTMLButtonElement>(null);
  const errorBack = useRef<HTMLButtonElement>(null);
  const previewBack = useRef<HTMLButtonElement>(null);
  const sourceTrigger = useRef<HTMLElement | null>(null);
  const installButton = useRef<HTMLButtonElement>(null);
  const errorReturnsToBack = useRef(false);
  useLayoutEffect(() => {
    if (!open || loading || discarding) return;
    if (preview) {
      const checked = !reviewing
        ? previewRegion.current?.querySelector<HTMLElement>(
            '[role="radio"][aria-checked="true"], input[type="radio"]:checked',
          )
        : null;
      (checked ?? previewBack.current)?.focus();
    } else if (sourceTrigger.current) {
      if (
        sourceTrigger.current === document.body ||
        !sourceTrigger.current.isConnected
      )
        browse.current?.focus();
      else sourceTrigger.current.focus();
      sourceTrigger.current = null;
    }
  }, [open, preview, loading, discarding, reviewing]);
  const hasSavedSource = !!savedSource;
  useLayoutEffect(() => {
    if (chooseSource && hasSavedSource) browse.current?.focus();
  }, [chooseSource, hasSavedSource]);
  const errorTrigger = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (busy || loading || discarding) return;
    if (error) errorBack.current?.focus();
    else if (errorTrigger.current) {
      if (errorTrigger.current === document.body) browse.current?.focus();
      else if (errorTrigger.current.isConnected) errorTrigger.current.focus();
      else if (errorReturnsToBack.current) previewBack.current?.focus();
      else (installButton.current ?? previewBack.current)?.focus();
      errorTrigger.current = null;
    }
  }, [error, busy, loading, discarding]);
  // Pending operations disable their control, so callers capture the return
  // target before starting rather than reading focus when the failure arrives.
  function showError(reason: unknown, returnTo: Element | null) {
    if (!error) {
      errorTrigger.current = returnTo as HTMLElement | null;
      errorReturnsToBack.current = returnTo === previewBack.current;
    }
    setError(String(reason));
  }
  const [enableOnInstall, setEnableOnInstall] = useState(true);
  const lifetime = useRef({ active: true, token: "" });
  const pending = useRef(false);
  const startSavedFolder = useEffectEvent(() => {
    if (imports && savedSource && "root" in savedSource) {
      const directory = savedSource.root;
      void load(() => imports.folder(directory));
    }
  });
  useEffect(() => {
    const current = { active: true, token: "" };
    lifetime.current = current;
    // Defer until effects settle so Strict Mode's retired mount never acquires.
    queueMicrotask(() => {
      if (current.active) startSavedFolder();
    });
    return () => {
      current.active = false;
      if (current.token) void imports?.discard(current.token).catch(() => {});
    };
  }, [imports]);

  const blocked = busy || loading || discarding;
  if (!imports) return null;

  async function load(operation: () => Promise<ImportPreview | null>) {
    if (pending.current || blocked) return;
    const returnTo = document.activeElement as HTMLElement | null;
    sourceTrigger.current = returnTo;
    pending.current = true;
    const current = lifetime.current;
    setLoading(true);
    setError(null);
    setPreview(null);
    setShowUnchanged(false);
    setEnableOnInstall(true);
    try {
      const result = await operation();
      let next =
        result && updateId
          ? {
              ...result,
              candidates: result.candidates.filter(
                (item) => item.manifest.id === updateId,
              ),
            }
          : result;
      if (
        next &&
        savedSource &&
        !chooseSource &&
        next.candidates.some((item) => item.path === savedSource.path)
      ) {
        next = {
          ...next,
          candidates: next.candidates.filter(
            (item) => item.path === savedSource.path,
          ),
        };
      }
      if (!current.active) {
        if (next) await imports?.discard(next.token);
        return;
      }
      current.token = next?.token ?? "";
      if (next && updateId) {
        if (!next.candidates.length) {
          await imports?.discard(next.token);
          current.token = "";
          throw new Error(
            "This source does not contain the selected plugin. Choose its built folder or repository.",
          );
        }
      }
      setPreview(next);
      setReviewing(next?.candidates.length === 1);
      setExisting(
        next?.candidates.length === 1
          ? catalog.plugins.find(
              (item) => item.manifest.id === next.candidates[0]?.manifest.id,
            )
          : undefined,
      );
      setSelected(
        next?.candidates.length === 1 ? (next.candidates[0]?.path ?? "") : "",
      );
    } catch (reason) {
      if (current.active) {
        if (savedSource && "root" in savedSource) setChooseSource(true);
        showError(reason, returnTo);
      }
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
      setShowUnchanged(false);
      if (savedSource && "root" in savedSource) setChooseSource(true);
    } catch (reason) {
      showError(reason, previewBack.current);
    } finally {
      pending.current = false;
      setDiscarding(false);
    }
  }
  async function close() {
    if (blocked || pending.current) return;
    const returnTo = document.activeElement;
    pending.current = true;
    setDiscarding(true);
    try {
      if (lifetime.current.token)
        await imports?.discard(lifetime.current.token);
      lifetime.current.token = "";
      setPreview(null);
      errorTrigger.current = null;
      setError(null);
      setDragging(false);
      setShowUnchanged(false);
      setOpen(false);
      onClosed?.();
    } catch (reason) {
      showError(reason, returnTo);
    } finally {
      pending.current = false;
      setDiscarding(false);
    }
  }
  const candidate = preview?.candidates.find((p) => p.path === selected);
  const updating = !!existing;
  const rollbackWarning =
    candidate?.publisher && existing && !existing.hasSignature
      ? "You cannot roll back to the unsigned revision after this update."
      : candidate?.revision === existing?.revision &&
          existing?.rollbackBlockedReason
        ? `${existing.rollbackBlockedReason}.`
        : null;
  const declaredDetails = candidate ? hostDeclarations(candidate.manifest) : [];
  const previousDetails = existing ? hostDeclarations(existing.manifest) : [];
  const previousGrants = previousDetails.map((grant) => grant.signature);
  const removedDetails = previousDetails.filter(
    (grant) => !declaredDetails.some((next) => next.key === grant.key),
  );
  const addedDetails = declaredDetails.filter(
    (grant) => !previousDetails.some((previous) => previous.key === grant.key),
  );
  const changedDetails = declaredDetails.filter((grant) =>
    previousDetails.some(
      (previous) =>
        previous.key === grant.key && previous.signature !== grant.signature,
    ),
  );
  const unchangedDetails = declaredDetails.filter((grant) =>
    previousGrants.includes(grant.signature),
  );
  const hasAccessChanges =
    addedDetails.length + changedDetails.length + removedDetails.length > 0;
  function scopeItem(
    grant: ReturnType<typeof hostDeclarations>[number],
    removed = false,
    compare = updating,
  ) {
    const changed =
      compare &&
      !!existing &&
      !removed &&
      !previousGrants.includes(grant.signature);
    const previous = changed
      ? previousDetails.find((item) => item.key === grant.key)
      : undefined;
    const changeLabel = changed ? (previous ? " (changed)" : " (added)") : "";
    const Icon = grant.icon;
    return {
      value: grant.signature,
      title: (
        <span className="flex items-start gap-3 text-left text-body-sm break-words">
          <Icon size={20} aria-hidden="true" className="shrink-0 text-muted" />
          <span className="min-w-0">
            <span className="block font-medium">
              {removed ? "Removed: " : ""}
              {grant.label}
              {changeLabel}
            </span>
            <span className="block text-muted">{grant.hint}</span>
          </span>
        </span>
      ),
      content: (
        <section
          aria-label={`${removed ? "Removed " : ""}${"name" in grant ? grant.name : grant.title.slice(0, -1)} details`}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Scroll owner supports keyboard access to long command details.
          tabIndex={0}
          className={styles.technicalDetails}
        >
          <p className="m-0 font-medium">
            {grant.title}
            {changeLabel}
          </p>
          {previous && (
            <>
              <p className="mb-2 mt-3 text-label">Previously</p>
              {previous.details}
              <p className="mb-2 mt-3 text-label">After this update</p>
            </>
          )}
          {grant.details}
        </section>
      ),
    };
  }
  const allDeclarations = (
    <section aria-label="Declared scopes">
      {(updating ? unchangedDetails : declaredDetails).length ? (
        <Accordion
          animate
          key={selected}
          items={(updating ? unchangedDetails : declaredDetails).map((grant) =>
            scopeItem(grant, false, false),
          )}
        />
      ) : (
        <p className="m-0">No additional capabilities declared.</p>
      )}
    </section>
  );
  const addButton = (
    <Button
      ref={trigger}
      size="sm"
      aria-label={
        updateId
          ? `Update ${catalog.plugins.find((item) => item.manifest.id === updateId)?.manifest.name ?? "plugin"}`
          : undefined
      }
      disabled={blocked}
      onClick={() => setOpen(true)}
    >
      {updateId ? "Update" : "Add"}
    </Button>
  );
  return (
    <>
      {!updateId &&
        (actionTarget ? createPortal(addButton, actionTarget) : addButton)}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) void close();
        }}
        title={
          showUnchanged
            ? "Unchanged declarations"
            : error || !preview
              ? updateId
                ? "Update plugin"
                : "Add a plugin"
              : reviewing
                ? existing
                  ? `Update ${existing.manifest.name}`
                  : "Review plugin access"
                : preview.candidates.length
                  ? "Choose a plugin"
                  : "No plugins found"
        }
        description={
          error ? undefined : preview ? (
            reviewing ? (
              updating ? (
                <>
                  {preview.commit ? "Source" : "Source folder"}:{" "}
                  <code className={styles.sourcePath}>
                    {importLocation(preview, candidate?.path)}
                  </code>
                </>
              ) : (
                "Only install code you trust."
              )
            ) : preview.candidates.length ? (
              "Select a plugin to review before installing."
            ) : (
              "Try another folder or repository."
            )
          ) : (
            "Choose a built plugin to load."
          )
        }
        size={error || (reviewing && updating) ? "default" : "wide"}
        leadingActions={
          reviewing &&
          candidate &&
          !updateId &&
          (!existing || loading) &&
          !error ? (
            <Switch
              label="Enable plugin"
              checked={enableOnInstall}
              disabled={blocked}
              onCheckedChange={setEnableOnInstall}
            />
          ) : undefined
        }
        actions={
          error ? (
            <Button
              ref={errorBack}
              type="button"
              disabled={blocked}
              onClick={() => {
                if (!preview && savedSource && "root" in savedSource)
                  errorTrigger.current = browse.current;
                setError(null);
              }}
            >
              Back
            </Button>
          ) : showUnchanged ? (
            <Button ref={unchangedBack} onClick={() => setShowUnchanged(false)}>
              Back
            </Button>
          ) : preview ? (
            <>
              <Button
                ref={previewBack}
                type="button"
                disabled={blocked}
                onClick={() => {
                  if (
                    reviewing &&
                    preview.candidates.length > 1 &&
                    !(savedSource && "root" in savedSource)
                  ) {
                    setReviewing(false);
                  } else void dismiss();
                }}
              >
                {savedSource && "root" in savedSource
                  ? "Change source folder"
                  : "Back"}
              </Button>
              {!reviewing && preview.candidates.length > 1 && (
                <Button
                  variant="prominent"
                  type="button"
                  disabled={blocked || !candidate}
                  onClick={() => {
                    setExisting(
                      catalog.plugins.find(
                        (item) => item.manifest.id === candidate?.manifest.id,
                      ),
                    );
                    setReviewing(true);
                  }}
                >
                  Continue
                </Button>
              )}
              {reviewing && candidate && (
                <Button
                  ref={installButton}
                  variant="prominent"
                  type="button"
                  disabled={blocked || existing?.source === "bundled"}
                  onClick={async () => {
                    if (blocked || pending.current) return;
                    const current = lifetime.current;
                    pending.current = true;
                    setLoading(true);
                    setError(null);
                    try {
                      const success = await plugins.installImport(
                        preview.token,
                        candidate.path,
                      );
                      if (!current.active) return;
                      if (!success) {
                        showError(
                          plugins.snapshot().error ??
                            "Plugin installation wasn’t confirmed. Check the preview and try again.",
                          installButton.current,
                        );
                        return;
                      }
                      // Native keeps the prepared preview after install.
                      current.token = "";
                      void imports.discard(preview.token).catch(() => {});
                      if (!existing && enableOnInstall)
                        await plugins.change("enable", candidate.manifest.id);
                      if (!current.active) return;
                      setPreview(null);
                      setOpen(false);
                      onClosed?.();
                    } finally {
                      pending.current = false;
                      if (current.active) setLoading(false);
                    }
                  }}
                >
                  {updating ? "Update plugin" : "Install plugin"}
                </Button>
              )}
            </>
          ) : undefined
        }
        onEscape={() => {
          if (!showUnchanged) return false;
          setShowUnchanged(false);
          return true;
        }}
        dismissOnOutsideClick
        preventClose={blocked}
        finalFocus={() => returnFocus?.() ?? trigger.current}
      >
        {error && (
          <p role="alert" className="error break-words">
            {error}
          </p>
        )}
        {showUnchanged && allDeclarations}
        <div hidden={!!error || showUnchanged}>
          <div
            hidden={
              !!preview ||
              (!!savedSource && "root" in savedSource && !chooseSource)
            }
          >
            {updateId && savedSource && !chooseSource ? (
              <section aria-label="Saved plugin source">
                <p className="mt-0 mb-2 text-body-sm break-words">
                  {"root" in savedSource
                    ? savedSource.root
                    : savedSource.repository}
                </p>
                <p className="mt-0 mb-4 text-body-sm text-muted break-words">
                  Plugin folder: {savedSource.path}
                </p>
                {"reference" in savedSource && (
                  <p className="mt-0 mb-4 text-body-sm text-muted">
                    Branch or tag:{" "}
                    {savedSource.reference || "Repository default"}
                  </p>
                )}
                <div className="flex flex-wrap gap-3">
                  {!("root" in savedSource) && (
                    <Button
                      disabled={blocked}
                      onClick={() =>
                        void load(async () => {
                          const signed = await authorizeGit?.(
                            savedSource.repository,
                          );
                          return imports.git(
                            signed?.repository ?? savedSource.repository,
                            savedSource.reference,
                            signed?.token,
                          );
                        })
                      }
                    >
                      Check this repository
                    </Button>
                  )}
                  <Button
                    disabled={blocked}
                    onClick={() => setChooseSource(true)}
                  >
                    Choose another source
                  </Button>
                </div>
              </section>
            ) : (
              <>
                {updateId && !savedSource && (
                  <p className="mt-0 mb-4 text-body-sm text-muted">
                    Buzz needs the source again. Choose or drop the replacement
                    folder, or enter its repository.
                  </p>
                )}
                <p className="mb-4 mt-0 text-body-sm text-muted">
                  Load built plugins containing manifest.json and plugin.js.
                  Buzz doesn’t build source code or run install scripts.
                </p>
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
                        items.length === 1
                          ? items[0]?.webkitGetAsEntry?.()
                          : null;
                      const current = lifetime.current;
                      void load(async () => {
                        if (!entry?.isDirectory)
                          throw new Error("Drop one folder, or choose Browse.");
                        const upload = await readPluginFolder(entry);
                        if (!current.active) return null;
                        const next = await imports.files(
                          upload.source,
                          upload.files,
                        );
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
                    <p className="m-0 text-body-sm">
                      Drop a plugin folder here
                    </p>
                    <Button
                      size="sm"
                      ref={browse}
                      aria-label="Browse plugin folder"
                      disabled={blocked}
                      onClick={() => void load(() => imports.folder())}
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
                            ? imports.git(
                                signed.repository,
                                reference,
                                signed.token,
                              )
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
                          onChange={(event) =>
                            setRepository(event.target.value)
                          }
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
                        HTTPS or SSH; GitHub owner/repository also works. SSH
                        uses your agent and known hosts. Password prompts and
                        credential helpers are not used. Buzz git repositories
                        in this community sign in with your account.
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
              </>
            )}
          </div>
          {loading && !preview && (
            <p role="status">
              Reading plugin folders… Git imports may take up to a minute.
            </p>
          )}
          {loading && preview && (
            <p role="status">
              {updating ? "Updating plugin…" : "Installing plugin…"}
            </p>
          )}
          {preview && (
            <section ref={previewRegion} aria-label="Plugin import preview">
              <div className="flex flex-col gap-4">
                {!reviewing &&
                  (preview.candidates.length === 0 || preview.commit) && (
                    <div className="min-w-0 text-body-sm">
                      {preview.candidates.length === 0 && (
                        <p className="m-0 break-all text-caption text-muted">
                          Source: {preview.source}
                        </p>
                      )}
                      {preview.commit && (
                        <p className="m-0 break-all text-caption text-muted">
                          Commit: {preview.commit}
                        </p>
                      )}
                    </div>
                  )}
                {preview.candidates.length === 0 ? (
                  <p className="m-0">
                    No built plugins found. Build the plugin first, then choose
                    its output folder, or use a repository that includes built
                    artifacts.
                  </p>
                ) : !reviewing && preview.candidates.length > 1 ? (
                  <Field label="Choose a plugin" labelVisibility="hidden">
                    <RadioGroup
                      name="plugin-folder"
                      aria-label="Choose a plugin"
                      value={selected}
                      disabled={busy}
                      onValueChange={(value) => {
                        setSelected(value);
                      }}
                    >
                      {preview.candidates.map((item) => (
                        <Radio
                          key={item.path}
                          value={item.path}
                          variant="card"
                          label={item.manifest.name}
                          description={
                            <span className="block break-all text-caption text-muted">
                              {importLocation(preview, item.path)} ·{" "}
                              {item.manifest.id}
                            </span>
                          }
                        />
                      ))}
                    </RadioGroup>
                  </Field>
                ) : null}
                {preview.warnings.length > 0 &&
                  (!reviewing || preview.candidates.length === 1) && (
                    <section
                      aria-label="Skipped folders"
                      className="text-body-sm"
                    >
                      <p className="m-0 text-label">
                        Folders skipped ({preview.warnings.length})
                      </p>
                      <p className="mb-0 mt-1 text-muted">
                        These folders couldn’t be loaded as plugins. Other
                        listed plugins can still be installed.
                      </p>
                      <ul className="mb-0 mt-2 list-disc space-y-1 break-words pl-4">
                        {preview.warnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    </section>
                  )}
                {reviewing &&
                  candidate &&
                  (existing?.source !== "bundled" || loading) && (
                    <section
                      aria-label="Computer access"
                      className="text-body-sm"
                    >
                      {updating && (
                        <section
                          aria-label="Declared access changes"
                          className="mb-4"
                        >
                          <p className="mt-0 mb-2 text-label">
                            {hasAccessChanges
                              ? "Declared access changes"
                              : "No declared access changes"}
                          </p>
                          {(
                            [
                              ["Added", addedDetails],
                              ["Changed", changedDetails],
                              ["Removed", removedDetails],
                            ] as const
                          ).map(
                            ([label, grants]) =>
                              grants.length > 0 && (
                                <section
                                  key={label}
                                  aria-label={`${label} declarations`}
                                  className="mt-3"
                                >
                                  <p className="mt-0 mb-2 text-label">
                                    {label}
                                  </p>
                                  <Accordion
                                    animate
                                    key={`${selected}-${label}`}
                                    items={grants.map((grant) =>
                                      scopeItem(grant, label === "Removed"),
                                    )}
                                  />
                                </section>
                              ),
                          )}
                        </section>
                      )}
                      {updating ? (
                        <p
                          className="mt-0 mb-4 text-body-sm text-muted"
                          role="note"
                        >
                          Plugins can access your computer beyond these
                          declarations. Only update code you trust.
                        </p>
                      ) : (
                        <Accordion
                          animate
                          key={`computer-${selected}`}
                          items={[
                            {
                              value: "computer-access",
                              title: (
                                <span className="flex items-start gap-3 text-left text-body-sm">
                                  <MonitorIcon
                                    size={20}
                                    className="shrink-0 text-muted"
                                    aria-hidden="true"
                                  />
                                  <span>
                                    <span className="block font-medium">
                                      Computer access
                                    </span>
                                    <span className="block text-muted">
                                      Can access files and run programs on your
                                      computer.
                                    </span>
                                  </span>
                                </span>
                              ),
                              content: (
                                <section
                                  aria-label="Plugin safety"
                                  className="max-w-prose pl-8 text-body"
                                >
                                  <h4 className="mb-2 mt-0 text-label">
                                    Access beyond this list
                                  </h4>
                                  <p className="m-0">
                                    Plugins aren’t sandboxed. They can access
                                    your computer beyond these declarations,
                                    even when no additional capabilities are
                                    listed.
                                  </p>
                                  <p className="mb-0 mt-3 text-muted">
                                    These declarations describe what the plugin
                                    asks Buzz to do. They don’t limit what its
                                    code can do.
                                  </p>
                                </section>
                              ),
                            },
                          ]}
                        />
                      )}
                      {updating
                        ? unchangedDetails.length > 0 && (
                            <Button
                              ref={unchangedTrigger}
                              size="sm"
                              onClick={() => setShowUnchanged(true)}
                            >
                              View unchanged declarations
                            </Button>
                          )
                        : allDeclarations}
                    </section>
                  )}
                {reviewing && existing?.source === "bundled" && !loading && (
                  <p className="m-0 text-body-sm">
                    This plugin is included with Buzz. Update Buzz to get its
                    latest version.
                  </p>
                )}
                {reviewing && candidate && existing?.source === "external" && (
                  <>
                    {!existing.enabled && (
                      <p className="m-0 text-body-sm text-muted">
                        This plugin will stay disabled.
                      </p>
                    )}
                    {rollbackWarning && (
                      <p className="m-0 text-body-sm">{rollbackWarning}</p>
                    )}
                  </>
                )}
              </div>
            </section>
          )}
        </div>
      </Dialog>
    </>
  );
}

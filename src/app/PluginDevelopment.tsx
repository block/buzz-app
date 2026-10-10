import { useEffect, useRef, useState } from "react";
import { Button } from "../shared/design-system/ui/Button";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import type { PluginManager } from "../plugins/manager";
import type { DevelopmentPreview, PluginInfo } from "../plugins/types";
import { hostGrants } from "./PluginImport";

/** Host-owned recovery stays mounted even if the selected plugin fails. */
export function PluginDevelopment({
  plugin,
  plugins,
  busy,
}: {
  plugin: PluginInfo;
  plugins: PluginManager;
  busy: boolean;
}) {
  const development = plugins.development;
  const [preview, setPreview] = useState<DevelopmentPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef({ active: true, pending: false, token: "" });
  useEffect(() => {
    const current = { active: true, pending: false, token: "" };
    lifetime.current = current;
    return () => {
      current.active = false;
      if (current.token)
        void development?.discard(current.token).catch(() => {});
    };
  }, [development]);
  if (!development || !plugin.developmentSupported) return null;

  async function choose() {
    const current = lifetime.current;
    if (!development || busy || current.pending) return;
    current.pending = true;
    setLoading(true);
    setError(null);
    try {
      if (current.token) await development.discard(current.token);
      current.token = "";
      setPreview(null);
      const next = await development.folder(plugin.manifest.id);
      if (!current.active) {
        if (next) await development.discard(next.token);
        return;
      }
      current.token = next?.token ?? "";
      setPreview(next);
    } catch (reason) {
      if (current.active) setError(String(reason));
    } finally {
      current.pending = false;
      if (current.active) setLoading(false);
    }
  }
  async function close() {
    const current = lifetime.current;
    if (!development || busy || current.pending) return;
    try {
      await development.discard(current.token);
      current.token = "";
      if (current.active) setPreview(null);
    } catch (reason) {
      if (current.active) setError(String(reason));
    }
  }
  const grants = preview ? hostGrants(preview.manifest) : [];
  const previous = hostGrants(plugin.manifest);
  return (
    <div className="mt-2 text-body-sm">
      <p role="status" className="m-0 text-subtle">
        {plugin.source === "development"
          ? "Local dev build · this launch only"
          : "Compiled build"}
      </p>
      <div className="actions items-center">
        <Button
          type="button"
          disabled={busy || loading}
          onClick={() => void choose()}
        >
          Use local dev build
        </Button>
        {plugin.source === "development" && (
          <Button
            type="button"
            disabled={busy || loading}
            onClick={() => void plugins.restoreCompiled(plugin.manifest.id)}
          >
            Use compiled
          </Button>
        )}
      </div>
      {loading && <p role="status">Reading local build…</p>}
      {error && (
        <p role="alert" className="error break-words">
          {error}
        </p>
      )}
      {preview && (
        <section
          aria-label={`Local build preview for ${plugin.manifest.name}`}
          className="mt-2"
        >
          <SettingsGroup layout="form">
            <p className="m-0 break-all">
              {preview.source} · {preview.manifest.id}
            </p>
            <section aria-label="Declared host access">
              <p className="m-0 font-medium">Declared host access</p>
              {grants.length ? (
                <ul className="m-0 break-all">
                  {grants.map((grant) => (
                    <li key={grant}>
                      {grant}
                      {previous.includes(grant) ? "" : " (new or changed)"}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0">
                  No commands, processes or HTTPS origins declared.
                </p>
              )}
              {previous.some((grant) => !grants.includes(grant)) && (
                <p className="m-0 break-all">
                  Removed:{" "}
                  {previous
                    .filter((grant) => !grants.includes(grant))
                    .join(", ")}
                </p>
              )}
            </section>
            <p className="m-0">
              This replaces the compiled implementation under the same identity.
              It stays {plugin.enabled ? "on and may run immediately" : "off"}.
              Only load code you trust: plugins aren’t sandboxed. Restart or Use
              compiled restores code, not data.
            </p>
            <div className="actions">
              <Button
                type="button"
                disabled={busy || loading}
                onClick={async () => {
                  const current = lifetime.current;
                  if (
                    (await plugins.attachDevelopment(preview.token)) &&
                    current.active
                  ) {
                    current.token = "";
                    setPreview(null);
                  }
                }}
              >
                Attach local build
              </Button>
              <Button
                type="button"
                disabled={busy || loading}
                onClick={() => void close()}
              >
                Close preview
              </Button>
            </div>
          </SettingsGroup>
        </section>
      )}
    </div>
  );
}

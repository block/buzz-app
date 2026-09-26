import { Button } from "../shared/design-system/ui/Button";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Select } from "../shared/design-system/ui/Select";
import {
  developerSettings,
  isLogLevel,
  logLevel,
  LOG_LEVELS,
  subscribeLogLevel,
} from "../features/developer/logging";
import type { RelayData } from "../features/relay/service";
import { clientMetrics } from "../features/developer/client-metrics";

type BrokerStats = {
  queries: number;
  errors: number;
  media: number;
  connects: number;
};

const STATS_POLL_MS = 5000;
const METRICS_POLL_MS = 2000;
const ms = (value: number | undefined) =>
  value === undefined ? "–" : `${Math.round(value)} ms`;

function ClientMetrics() {
  const [summary, setSummary] = useState(clientMetrics.summary);
  useEffect(() => {
    const timer = setInterval(
      () => setSummary(clientMetrics.summary()),
      METRICS_POLL_MS,
    );
    return () => clearInterval(timer);
  }, []);
  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(clientMetrics.export(), null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `buzz-client-metrics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    link.click();
    // WebKit may still be reading the blob when click() returns.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const { opens, mainThread, phases } = summary;
  const cells = [
    ["Channel opens", String(opens.n)],
    [
      "Cache hits",
      opens.cacheHitRate === undefined
        ? "–"
        : `${Math.round(opens.cacheHitRate * 100)}%`,
    ],
    ["Open p50 / p90", `${ms(opens.p50)} / ${ms(opens.p90)}`],
    ["Not timed", String(opens.skipped)],
    ...Object.entries(opens.bySource).map(([source, value]) => [
      `From ${source}`,
      `${value.n} · p50 ${ms(value.p50)}`,
    ]),
    ["Long tasks", `${mainThread.longTasks} · ${ms(mainThread.longTaskMs)}`],
    ["During background work", ms(mainThread.backgroundLongTaskMs)],
    ...Object.entries(mainThread.cpu).map(([stage, value]) => [
      stage,
      `${ms(value.ms)} · ${value.count}`,
    ]),
  ];
  return (
    <div className="space-y-2">
      <h3 className="m-0 text-label-sm">Client performance</h3>
      <p className="m-0 text-body-sm text-muted">
        Measured in this window since it loaded. Nothing is sent anywhere.
      </p>
      <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-1 text-body-sm sm:grid-cols-3">
        {cells.map(([label, value]) => (
          <div key={label}>
            <dt className="text-muted">{label}</dt>
            <dd className="m-0 tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {phases.map((phase, index) => (
        <p
          // Phases are append-only; the index is their identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          key={index}
          className="m-0 text-body-sm tabular-nums"
        >
          {phase.kind === "open" ? "App open" : `Reconnect ${index}`}: auth{" "}
          {ms(phase.authMs)}, {phase.routes} channel subscriptions live in{" "}
          {ms(phase.coverageMs)} (each p50 {ms(phase.routeMs.p50)}, max{" "}
          {ms(phase.routeMs.max)}
          {phase.routeErrors ? `, ${phase.routeErrors} failed` : ""}),{" "}
          {phase.queries} reads ({phase.background} background),{" "}
          {Math.round(phase.bytes / 1024)} KB
        </p>
      ))}
      <div className="flex gap-2">
        <Button type="button" onClick={download}>
          Export JSON
        </Button>
        <Button
          type="button"
          onClick={() => {
            clientMetrics.reset();
            setSummary(clientMetrics.summary());
          }}
        >
          Reset
        </Button>
      </div>
    </div>
  );
}

/** Only the dev broker serves /api/relay/*. Packaged builds and proxied
 * deployments have no such endpoint, so absence is normal, not an error. */
async function fetchStats(): Promise<BrokerStats | undefined> {
  try {
    const res = await fetch("/api/relay/stats");
    if (!res.ok) return undefined;
    return (await res.json()) as BrokerStats;
  } catch {
    return undefined;
  }
}

export function DeveloperSettings({ relay }: { relay: RelayData }) {
  const level = useSyncExternalStore(subscribeLogLevel, logLevel);
  const [settingsReady, setSettingsReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string>();
  useEffect(() => {
    let alive = true;
    void developerSettings()
      .then(() => {
        if (alive) setSettingsReady(true);
      })
      .catch(() => {
        if (alive)
          setSettingsError(
            "Runtime settings require the local development server.",
          );
      });
    return () => {
      alive = false;
    };
  }, []);
  async function saveLevel(value: string) {
    if (!isLogLevel(value)) return;
    setSaving(true);
    setSettingsError(undefined);
    try {
      await developerSettings(value);
    } catch {
      setSettingsError("Log level wasn’t saved. Try again.");
    } finally {
      setSaving(false);
    }
  }
  const [stats, setStats] = useState<BrokerStats>();
  const [clearing, setClearing] = useState(false);
  const [status, setStatus] = useState<string>();

  useEffect(() => {
    let alive = true;
    async function poll() {
      const next = await fetchStats();
      if (alive) setStats(next);
    }
    void poll();
    const timer = setInterval(poll, STATS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  async function clearCache() {
    setClearing(true);
    try {
      await relay.clearCache();
      setStatus("Cache cleared. Buzz will load channels and media as needed.");
    } catch (error) {
      setStatus(`Buzz couldn’t clear the cache. ${String(error)}`);
    } finally {
      setClearing(false);
    }
  }

  return (
    <section aria-labelledby="developer-settings-title">
      <h2 id="developer-settings-title" className="mt-0 mb-6 text-label">
        Developer
      </h2>
      <div className="ui-card space-y-5 p-5 sm:p-6">
        <p className="text-body-sm text-muted">
          View local development diagnostics. This section appears only in
          development builds served from localhost.
        </p>
        <div className="space-y-2">
          <h3 className="m-0 text-label-sm">Runtime settings</h3>
          <Select
            label="Log level"
            value={level}
            disabled={!settingsReady || saving}
            onValueChange={(value) => void saveLevel(value)}
            groups={[
              {
                label: "",
                options: Object.keys(LOG_LEVELS).map((value) => ({
                  value,
                  label: value.charAt(0).toUpperCase() + value.slice(1),
                })),
              },
            ]}
          />
          <p className="m-0 text-body-sm text-muted">
            Applies immediately and survives restarts of this worktree. Info
            shows lifecycle messages; Debug shows every broker HTTP request and
            relay WebSocket frame; Trace adds safe protocol metadata. Message
            bodies and credentials are never included. Browser relay diagnostics
            use the same level.
          </p>
          {settingsError && (
            <p role="alert" className="m-0 text-body-sm text-muted">
              {settingsError}
            </p>
          )}
        </div>
        <div className="space-y-2">
          <h3 className="m-0 text-label-sm">Relay broker stats</h3>
          {stats ? (
            <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-1 text-body-sm sm:grid-cols-4">
              <div>
                <dt className="text-muted">Queries</dt>
                <dd className="m-0 tabular-nums">{stats.queries}</dd>
              </div>
              <div>
                <dt className="text-muted">Errors</dt>
                <dd className="m-0 tabular-nums">{stats.errors}</dd>
              </div>
              <div>
                <dt className="text-muted">Media</dt>
                <dd className="m-0 tabular-nums">{stats.media}</dd>
              </div>
              <div>
                <dt className="text-muted">Connects</dt>
                <dd className="m-0 tabular-nums">{stats.connects}</dd>
              </div>
            </dl>
          ) : (
            <p role="status" className="m-0 text-body-sm text-muted">
              Broker stats aren’t available. Start the development relay broker
              on this origin to view them.
            </p>
          )}
        </div>
        {clientMetrics.enabled && <ClientMetrics />}
        <div className="space-y-2">
          <h3 className="m-0 text-label-sm">Caches</h3>
          <p className="m-0 text-body-sm text-muted">
            Clear cached channels, messages, and media. Buzz keeps your account,
            relay, and sidebar settings.
          </p>
          <Button
            type="button"
            disabled={clearing}
            onClick={() => void clearCache()}
          >
            {clearing ? "Clearing…" : "Clear cache"}
          </Button>
          {status && (
            <p role="status" className="m-0 text-body-sm text-muted">
              {status}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

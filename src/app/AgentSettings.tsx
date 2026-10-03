import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AgentControl } from "../features/agents/control";
import {
  setRememberAgentsPreference,
  useRememberAgentsPreference,
} from "../features/messages/mention-preferences";
import { QuestionIcon } from "../shared/design-system/icons";
import { Header, InlineHeader } from "../shared/design-system/ui/Header";
import { Button } from "../shared/design-system/ui/Button";
import { IconButton } from "../shared/design-system/ui/IconButton";
import { SwitchPreferenceRow } from "../shared/design-system/ui/SwitchPreferenceRow";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { Tooltip } from "../shared/design-system/ui/Tooltip";
import { AgentDefaultsCard } from "./AgentDefaultsCard";
import styles from "./AgentSettings.module.css";

const acpHint =
  "Buzz talks to harnesses through the Agent Client Protocol (ACP). Goose ships with Buzz and supports ACP natively. Pi needs a small adapter, `buzz-pi-acp`. Your existing CLI setup and sign-in are left untouched.";
const piCommand = "npm install -g '@earendil-works/pi-coding-agent@>=0.99.0'";
const adapterCommand =
  "npm install -g --install-links=true 'git+https://github.com/salman1993/buzz-pi-acp.git#72015de'";
const labels = {
  ready: "Ready",
  "cli-needed": "CLI needed",
  "adapter-needed": "Adapter needed",
} as const;
const commands = [
  ["Pi", piCommand],
  ["Adapter", adapterCommand],
] as const;

export function AgentSettings({
  control,
  active = true,
}: {
  control: AgentControl;
  active?: boolean;
}) {
  const preference = useRememberAgentsPreference();
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  const copyAttempt = useRef(0);
  const state = useSyncExternalStore(control.subscribe, control.snapshot);
  const {
    installing: installingPi,
    report: piResult,
    error: piError,
  } = state.piInstall ?? { installing: false, report: null, error: null };
  useEffect(() => {
    if (active) void control.refresh();
  }, [active, control]);
  const options = state.data?.harnessOptions;
  const harnesses = (["Buzz Agent", "Goose", "Pi"] as const).map((name) =>
    options?.find((option) => option.label === name),
  );
  const available = harnesses.every((option) => !!option?.status);
  const pi = harnesses[2];
  const change = (enabled: boolean) =>
    setError(setRememberAgentsPreference(enabled));
  const copy = async (name: string, command: string) => {
    const attempt = ++copyAttempt.current;
    try {
      await navigator.clipboard.writeText(command);
      if (attempt === copyAttempt.current)
        setCopyMessage(`${name} command copied.`);
    } catch {
      if (attempt === copyAttempt.current)
        setCopyMessage(
          `Couldn’t copy the ${name} command. Select it to copy manually.`,
        );
    }
  };
  return (
    <section aria-labelledby="agent-settings-title">
      <Header id="agent-settings-title" title="Agents" />
      <section aria-labelledby="harnesses-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <InlineHeader id="harnesses-title" title="Harnesses" />
          <div className={styles.harnessActions}>
            <Tooltip content={acpHint}>
              <IconButton
                size="sm"
                aria-label="About ACP"
                icon={<QuestionIcon size={16} aria-hidden="true" />}
              />
            </Tooltip>
            <Button
              size="sm"
              type="button"
              disabled={
                state.status === "unavailable" || state.busy || installingPi
              }
              loading={checking}
              onClick={() => {
                setChecking(true);
                void control.refresh().finally(() => setChecking(false));
              }}
            >
              Check again
            </Button>
          </div>
        </div>
        <SettingsGroup layout="form">
          {state.status === "unavailable" ? (
            <p className="text-body-sm text-secondary">
              Harness detection requires the desktop app.
            </p>
          ) : state.status === "loading" || state.status === "idle" ? (
            <p role="status" className="text-body-sm text-secondary">
              Checking harnesses…
            </p>
          ) : !available ? (
            <p
              role={state.status === "error" ? "alert" : "status"}
              className="text-body-sm text-secondary"
            >
              {state.status === "error"
                ? "Couldn’t check harnesses. Select Check again to retry."
                : "Update the desktop app to check harnesses."}
            </p>
          ) : (
            <>
              {state.status === "error" && (
                <p role="alert">
                  Couldn’t confirm harnesses. Showing the last check; try Check
                  again.
                </p>
              )}
              <ul className={styles.rows}>
                {harnesses.map((option) => (
                  <li key={option?.label} className="py-3 text-body-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>{option?.label}</span>
                      <span className="flex items-center gap-2">
                        <span className="text-secondary">
                          {option?.status ? labels[option.status] : "Unknown"}
                        </span>
                        {option?.label === "Pi" &&
                          (option.status !== "ready" ||
                            option.updateSupported) &&
                          option.installSupported &&
                          control.installPi &&
                          !piResult?.ready && (
                            <Button
                              size="sm"
                              type="button"
                              loading={installingPi}
                              disabled={
                                state.status !== "ready" ||
                                state.busy ||
                                installingPi
                              }
                              onClick={() => {
                                void control.installPi?.().catch(() => {});
                              }}
                            >
                              {option.status === "ready"
                                ? "Update Pi"
                                : "Install"}
                            </Button>
                          )}
                      </span>
                    </div>
                    {option?.label === "Pi" &&
                      (installingPi ||
                        piResult?.ready ||
                        piResult?.error ||
                        piError ||
                        pi?.status !== "ready") && (
                        <div className={`${styles.piSetup} space-y-3`}>
                          {installingPi && (
                            <p role="status">
                              Installing Pi and its ACP adapter…
                            </p>
                          )}
                          {!installingPi &&
                            piResult?.ready &&
                            pi?.status === "ready" && (
                              <p role="status">
                                Pi and its adapter are up to date. Restart
                                running Pi agents to use them. Restarted{" "}
                                {piResult.restarted} waiting agents.
                                {piResult.restartFailures > 0 &&
                                  ` ${piResult.restartFailures} agents could not restart; check Agents.`}
                              </p>
                            )}
                          {!installingPi && (piResult?.error || piError) && (
                            <div role="alert" className="text-body-sm">
                              <p className="whitespace-pre-wrap break-words">
                                {piResult?.error || piError}
                              </p>
                              {piResult && (
                                <details>
                                  <summary>Pi install log</summary>
                                  <p className="break-all">
                                    {piResult.logPath}
                                  </p>
                                  <pre
                                    className={`${styles.command} whitespace-pre-wrap break-all`}
                                  >
                                    {piResult.output ||
                                      "No output was recorded."}
                                  </pre>
                                </details>
                              )}
                            </div>
                          )}
                          {pi?.status !== "ready" && (
                            <div className="space-y-3 text-body-sm">
                              <p className="m-0 text-secondary">
                                {pi?.installSupported && control.installPi
                                  ? "Click Install. Buzz installs Node.js, Pi, and its ACP adapter for you."
                                  : "Use Manual setup on this device, then click Check again."}{" "}
                                Your existing CLI setup and sign-in are left
                                untouched.
                              </p>
                              <details>
                                <summary>Manual setup</summary>
                                <div className="space-y-3 mt-3">
                                  <p className="m-0 text-secondary">
                                    Install Node.js 22.19 or newer, then run
                                    these commands in your terminal. Click Check
                                    again after installing.
                                  </p>
                                  {commands.map(([name, command]) => (
                                    <div
                                      key={name}
                                      className="flex min-w-0 flex-wrap items-center gap-2"
                                    >
                                      <code
                                        className={`${styles.command} min-w-0 flex-1 text-mono`}
                                      >
                                        {command}
                                      </code>
                                      <Button
                                        size="sm"
                                        type="button"
                                        onClick={() => void copy(name, command)}
                                      >
                                        Copy {name} command
                                      </Button>
                                    </div>
                                  ))}
                                  {copyMessage && (
                                    <p role="status" className="m-0">
                                      {copyMessage}
                                    </p>
                                  )}
                                </div>
                              </details>
                            </div>
                          )}
                        </div>
                      )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </SettingsGroup>
      </section>
      <AgentDefaultsCard control={control} state={state} />
      <div className="mt-section-gap">
        <InlineHeader title="Messages" />
        <SettingsGroup>
          <SwitchPreferenceRow
            label="Remember mentioned agents"
            description="Keep the same agents selected for your next message in this channel or thread."
            checked={preference}
            onCheckedChange={change}
          />
        </SettingsGroup>
      </div>
      {active && error && (
        <ToastNotice title="Agent preference wasn’t saved" description={error}>
          <Button type="button" size="sm" onClick={() => change(preference)}>
            Retry saving
          </Button>
        </ToastNotice>
      )}
    </section>
  );
}

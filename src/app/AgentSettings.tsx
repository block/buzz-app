import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AgentControl } from "../features/agents/control";
import {
  setRememberAgentsPreference,
  useRememberAgentsPreference,
} from "../features/messages/mention-preferences";
import {
  ArrowsClockwiseIcon,
  CopyIcon,
  GooseLogoIcon,
  PiLogoIcon,
  PlusIcon,
  QuestionIcon,
  RobotIcon,
  TerminalWindowIcon,
} from "../shared/design-system/icons";
import { Header, InlineHeader } from "../shared/design-system/ui/Header";
import { Button } from "../shared/design-system/ui/Button";
import { Dialog } from "../shared/design-system/ui/Dialog";
import { NavigationItem } from "../shared/design-system/ui/NavigationItem";
import { IconButton } from "../shared/design-system/ui/IconButton";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { SwitchPreferenceRow } from "../shared/design-system/ui/SwitchPreferenceRow";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { Tooltip } from "../shared/design-system/ui/Tooltip";
import type { ReactNode } from "react";
import { AgentDefaultsCard } from "./AgentDefaultsCard";
import styles from "./AgentSettings.module.css";

const acpHint =
  "Buzz talks to harnesses through the Agent Client Protocol (ACP). Goose ships with Buzz. Pi needs the buzz-pi-acp adapter. Hermes Agent uses its own ACP launcher and sign-in.";
const piCommand = "npm install -g '@earendil-works/pi-coding-agent@>=0.99.0'";
const adapterCommand =
  "npm install -g --install-links=true 'git+https://github.com/salman1993/buzz-pi-acp.git#72015de'";
const labels = {
  ready: "Ready",
  "cli-needed": "CLI needed",
  "adapter-needed": "Adapter needed",
} as const;
// Artwork only; native harnessOptions still own availability and configuration.
const harnessIcons: Record<string, ReactNode> = {
  "Buzz Agent": <RobotIcon size={32} className="shrink-0" />,
  Goose: <GooseLogoIcon size={32} className="shrink-0" />,
  Pi: <PiLogoIcon size={32} className="shrink-0" />,
  "Hermes Agent": <TerminalWindowIcon size={32} className="shrink-0" />,
};
const commands = [
  ["Pi", "Install Pi", piCommand],
  ["Adapter", "Install the ACP adapter", adapterCommand],
] as const;

export function AgentSettings({
  control,
  active = true,
  archive,
}: {
  control: AgentControl;
  active?: boolean;
  archive?: ReactNode;
}) {
  const preference = useRememberAgentsPreference();
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const addHarnessRef = useRef<HTMLButtonElement>(null);
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
  const coreHarnesses = (["Buzz Agent", "Goose", "Pi"] as const).map((name) =>
    options?.find((option) => option.label === name),
  );
  const available = coreHarnesses.every((option) => !!option?.status);
  const pi = coreHarnesses[2];
  const hermes = options?.find((option) => option.label === "Hermes Agent");
  const harnesses = hermes?.available
    ? [...coreHarnesses, hermes]
    : coreHarnesses;
  const checkDisabled =
    state.status === "unavailable" || state.busy || installingPi;
  const checkAgain = () => {
    setChecking(true);
    void control.refresh().finally(() => setChecking(false));
  };
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
        <InlineHeader
          id="harnesses-title"
          title="Harnesses"
          actions={
            <>
              <Tooltip content={acpHint}>
                <IconButton
                  size="sm"
                  aria-label="About ACP"
                  icon={<QuestionIcon size={16} aria-hidden="true" />}
                />
              </Tooltip>
              <Tooltip content="Check again">
                <IconButton
                  size="sm"
                  variant="ghost"
                  aria-label="Check again"
                  icon={<ArrowsClockwiseIcon aria-hidden="true" />}
                  disabled={checkDisabled}
                  loading={checking}
                  onClick={checkAgain}
                />
              </Tooltip>
            </>
          }
        />
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
              <ul aria-labelledby="harnesses-title" className={styles.rows}>
                {harnesses.map((option) => (
                  <li key={option?.label} className="py-3 text-body-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex items-center gap-3">
                        {option && harnessIcons[option.label]}
                        <span>{option?.label}</span>
                      </span>
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
                    {option?.label === "Hermes Agent" && (
                      <div
                        className={`${styles.piSetup} space-y-3 text-body-sm`}
                      >
                        <p className="m-0 text-secondary">
                          Uses the default model and credentials configured in
                          Hermes. Install and update Hermes yourself, then use
                          Check again.
                        </p>
                        <details>
                          <summary>Manual Hermes setup</summary>
                          <div className="mt-3">
                            <HermesSetup />
                          </div>
                        </details>
                      </div>
                    )}
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
                                  <ol
                                    aria-label="Manual setup steps"
                                    className={styles.rows}
                                  >
                                    <li>
                                      <PreferenceRow
                                        title="Install Node.js"
                                        subtitle="Use version 22.19 or newer. Run the following commands in your terminal."
                                      />
                                    </li>
                                    {commands.map(([name, title, command]) => (
                                      <li key={name}>
                                        <PreferenceRow
                                          title={title}
                                          subtitle={
                                            <code
                                              className={`${styles.command} text-mono`}
                                            >
                                              {command}
                                            </code>
                                          }
                                          trailing={
                                            <Tooltip
                                              content={`Copy ${name} command`}
                                            >
                                              <IconButton
                                                size="sm"
                                                variant="ghost"
                                                aria-label={`Copy ${name} command`}
                                                icon={
                                                  <CopyIcon aria-hidden="true" />
                                                }
                                                onClick={() =>
                                                  void copy(name, command)
                                                }
                                              />
                                            </Tooltip>
                                          }
                                        />
                                      </li>
                                    ))}
                                    <li>
                                      <PreferenceRow
                                        title="Check the installation"
                                        subtitle="Use Check again at the top of Harnesses to refresh the status."
                                      />
                                    </li>
                                  </ol>
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
              <Button
                ref={addHarnessRef}
                variant="outline"
                size="sm"
                onClick={() => setCatalogOpen(true)}
              >
                <PlusIcon size={16} aria-hidden="true" />
                Add harness
              </Button>
            </>
          )}
        </SettingsGroup>
      </section>
      <Dialog
        open={catalogOpen && active}
        onOpenChange={setCatalogOpen}
        title="Add harness"
        finalFocus={addHarnessRef}
        dismissOnOutsideClick
        actions={
          <Button
            size="sm"
            variant="outline"
            loading={checking}
            disabled={checkDisabled}
            onClick={checkAgain}
          >
            <ArrowsClockwiseIcon size={16} aria-hidden="true" />
            Check again
          </Button>
        }
      >
        <div className={styles.catalog}>
          <nav
            aria-label="Additional harnesses"
            className={styles.catalogSidebar}
          >
            <p className="text-label text-secondary">
              {hermes?.available ? "Installed" : "Setup"}
            </p>
            <NavigationItem
              label="Hermes Agent"
              selected
              icon={<TerminalWindowIcon size={24} aria-hidden="true" />}
            />
          </nav>
          <section
            aria-labelledby="hermes-catalog-title"
            className={`${styles.catalogDetails} space-y-4`}
          >
            <div className="flex items-center gap-3">
              {harnessIcons["Hermes Agent"]}
              <div>
                <h3 id="hermes-catalog-title" className="text-label">
                  Hermes Agent
                </h3>
                <p className="m-0 text-body-sm text-secondary">
                  {hermes?.status ? labels[hermes.status] : "Unknown"}
                </p>
              </div>
            </div>
            <p className="text-body-sm text-secondary">
              A general-purpose AI agent from Nous Research.
            </p>
            {state.status === "error" && (
              <p role="alert" className="text-body-sm">
                Couldn’t confirm harnesses. Showing the last check; try Check
                again.
              </p>
            )}
            {!hermes && (
              <p role="status" className="text-body-sm">
                Update the desktop app to check Hermes Agent.
              </p>
            )}
            <p className="text-body-sm">
              Uses the default model and credentials configured in Hermes.
              Install and update Hermes yourself.
            </p>
            <HermesSetup />
            {hermes?.available && (
              <PreferenceRow
                title="Executable"
                subtitle={
                  <code className={styles.command}>{hermes.command}</code>
                }
              />
            )}
          </section>
        </div>
      </Dialog>
      <AgentDefaultsCard control={control} state={state} />
      {archive}
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

function HermesSetup() {
  return (
    <div className="space-y-3 text-body-sm">
      <p>
        Follow the{" "}
        <a
          className="underline"
          href="https://hermes-agent.nousresearch.com/docs/user-guide/features/acp/"
          target="_blank"
          rel="noreferrer"
        >
          Hermes ACP setup guide
        </a>{" "}
        to install Hermes with ACP support. Configure its model and sign-in with{" "}
        <code>hermes model</code>, then run <code>hermes acp --check</code> in
        your terminal. Buzz looks for the <code>hermes-acp</code> launcher.
      </p>
      <p>Use Check again to refresh the installation status.</p>
    </div>
  );
}

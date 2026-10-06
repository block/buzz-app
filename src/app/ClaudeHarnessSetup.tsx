import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentControl,
  AgentControlState,
} from "../features/agents/control";
import { ClaudeLogoIcon } from "../shared/design-system/icons";
import { Button } from "../shared/design-system/ui/Button";
import styles from "./AgentSettings.module.css";

const cliCommand = "npm install -g @anthropic-ai/claude-code@2.1.289";
const adapterCommand =
  "npm install -g @agentclientprotocol/claude-agent-acp@0.85.1";

export function ClaudeHarnessSetup({
  control,
  state,
  active = true,
}: {
  control: AgentControl;
  state: AgentControlState;
  active?: boolean;
}) {
  const setup = state.data?.claudeSetup;

  const { installing, report, error } = state.claudeInstall ?? {
    installing: false,
    report: null,
    error: null,
  };
  const toolsReady = setup?.status === "ready";
  const [auth, setAuth] = useState<boolean | null | "checking">("checking");
  const statusRef = useRef<HTMLSpanElement>(null);
  const installRef = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    return () => {
      if (button.ownerDocument.activeElement === button) {
        statusRef.current?.focus();
      }
    };
  }, []);
  // A new install result also rechecks auth if React batches a fast install.
  // biome-ignore lint/correctness/useExhaustiveDependencies: install completion must trigger this read even when tool presence is unchanged.
  useEffect(() => {
    if (!active || !toolsReady || installing) return;
    let current = true;
    setAuth("checking");
    void (control.checkClaudeAuth?.() ?? Promise.resolve(null))
      .catch(() => null)
      .then((result) => {
        if (current) setAuth(result);
      });
    return () => {
      current = false;
    };
  }, [active, toolsReady, installing, report, control]);
  if (!setup) return null;
  const ready = toolsReady && auth === true;
  const needsGuidance = !toolsReady || auth === false || auth === null;
  const showDetails = installing || report?.error || error || needsGuidance;
  return (
    <li aria-label="Claude Code harness" className="py-3 text-body-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-3">
          <ClaudeLogoIcon size={32} className="shrink-0" />
          <span>Claude Code</span>
        </span>
        <span className="flex items-center gap-2">
          <span ref={statusRef} tabIndex={-1} className="text-secondary">
            {ready
              ? "Ready"
              : toolsReady
                ? auth === "checking"
                  ? "Checking sign-in…"
                  : auth === false
                    ? "Sign-in needed"
                    : "Sign-in unconfirmed"
                : setup.status === "cli-needed"
                  ? "CLI needed"
                  : "Adapter needed"}
          </span>
          {!toolsReady && setup.installSupported && control.installClaude && (
            <Button
              ref={installRef}
              size="sm"
              loading={installing}
              disabled={
                state.status !== "ready" ||
                state.busy ||
                state.piInstall?.installing
              }
              onClick={() => void control.installClaude?.().catch(() => {})}
            >
              Install
            </Button>
          )}
        </span>
      </div>
      {showDetails && (
        <div className={`${styles.piSetup} space-y-3`}>
          {installing && (
            <p role="status">Installing Claude Code and its ACP adapter…</p>
          )}
          {!installing && (report?.error || error) && (
            <div role="alert">
              <p className="whitespace-pre-wrap break-words">
                {report?.error || error}
              </p>
              {report && (
                <details>
                  <summary>Claude Code install log</summary>
                  <p className="break-all">{report.logPath}</p>
                  <pre
                    className={`${styles.command} whitespace-pre-wrap break-all`}
                  >
                    {report.output || "No output was recorded."}
                  </pre>
                </details>
              )}
            </div>
          )}
          {!toolsReady && (
            <>
              <p className="m-0 text-secondary">
                {setup.installSupported && control.installClaude
                  ? "Click Install. Buzz installs Node.js, Claude Code, and its ACP adapter for you."
                  : "Use Manual setup on this device, then click Check again."}
              </p>
              <details>
                <summary>Manual Claude Code setup</summary>
                <div className="space-y-3 mt-3">
                  <p>
                    Install Node.js 22 or newer, then run these in your
                    terminal:
                  </p>
                  {[cliCommand, adapterCommand].map((command) => (
                    <code
                      key={command}
                      className={`${styles.command} block text-mono`}
                    >
                      {command}
                    </code>
                  ))}
                  <p>Use Check again to refresh the installation status.</p>
                </div>
              </details>
            </>
          )}
          {toolsReady && auth === null && (
            <p className="m-0 text-secondary">
              Couldn’t confirm Claude Code sign-in. Use Check again to retry, or
              sign in below.
            </p>
          )}
          {needsGuidance && setup.loginCommand && (
            <details>
              <summary>Sign in to Claude Code</summary>
              <p className="mt-3">
                Run this in your terminal and follow Claude’s sign-in steps:
              </p>
              <code className={`${styles.command} block text-mono`}>
                {setup.loginCommand}
              </code>
            </details>
          )}
        </div>
      )}
    </li>
  );
}

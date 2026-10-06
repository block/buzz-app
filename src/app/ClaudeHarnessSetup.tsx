import type {
  AgentControl,
  AgentControlState,
} from "../features/agents/control";
import { TerminalWindowIcon } from "../shared/design-system/icons";
import { Button } from "../shared/design-system/ui/Button";
import styles from "./AgentSettings.module.css";

const cliCommand = "npm install -g @anthropic-ai/claude-code@2.1.289";
const adapterCommand =
  "npm install -g @agentclientprotocol/claude-agent-acp@0.85.1";

export function ClaudeHarnessSetup({
  control,
  state,
}: {
  control: AgentControl;
  state: AgentControlState;
}) {
  const setup = state.data?.claudeSetup;
  if (!setup) return null;
  const { installing, report, error } = state.claudeInstall ?? {
    installing: false,
    report: null,
    error: null,
  };
  const ready = setup.status === "ready";
  return (
    <li aria-label="Claude Code harness" className="py-3 text-body-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-3">
          <TerminalWindowIcon size={32} className="shrink-0" />
          <span>Claude Code</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="text-secondary">
            {ready
              ? "Ready"
              : setup.status === "cli-needed"
                ? "CLI needed"
                : "Adapter needed"}
          </span>
          {!ready && setup.installSupported && control.installClaude && (
            <Button
              size="sm"
              loading={installing}
              disabled={
                state.status !== "ready" ||
                state.busy ||
                installing ||
                state.piInstall?.installing
              }
              onClick={() => void control.installClaude?.().catch(() => {})}
            >
              Install
            </Button>
          )}
        </span>
      </div>
      <div className={`${styles.piSetup} space-y-3`}>
        {installing && (
          <p role="status">Installing Claude Code and its ACP adapter…</p>
        )}
        {!installing && report?.ready && ready && (
          <p role="status">Claude Code and its ACP adapter are installed.</p>
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
        {!ready && (
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
                  Install Node.js 22 or newer, then run these in your terminal:
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
        {setup.loginCommand && (
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
        <p className="m-0 text-secondary">
          Ready means the tools are installed. Sign-in is managed by Claude
          Code. Agent creation with Claude Code will be available in a later
          update.
        </p>
      </div>
    </li>
  );
}

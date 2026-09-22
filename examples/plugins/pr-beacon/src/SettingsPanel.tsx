import type { Context } from "@buzz/author";
import { GitHubError, fetchViewerLogin } from "./github";
import type { Preferences } from "./preferences";

type ReactRuntime = Context["react"];

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

type ConnectState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "error"; message: string };

export function createSettingsPanel(React: ReactRuntime) {
  return function SettingsPanel(props: {
    hasToken: boolean;
    onSubmitToken: (token: string) => void;
    onClearToken: () => void;
    preferences: Preferences;
    onChangePreferences: (next: Preferences) => void;
    saveError: string | null;
  }) {
    const [tokenInput, setTokenInput] = React.useState("");
    const [connectState, setConnectState] = React.useState<ConnectState>({
      status: "idle",
    });
    const [vipInput, setVipInput] = React.useState(
      props.preferences.vipLogins.join(", "),
    );
    const [labelInput, setLabelInput] = React.useState(
      props.preferences.watchedLabels.join(", "),
    );

    const controllerRef = React.useRef<AbortController | null>(null);
    // Aborts an in-flight connection test on unmount so a slow GitHub
    // response can never call onSubmitToken or setState after teardown.
    React.useEffect(() => () => controllerRef.current?.abort(), []);

    async function handleConnect(event: { preventDefault: () => void }) {
      event.preventDefault();
      const value = tokenInput.trim();
      if (!value || connectState.status === "pending") return;
      const controller = new AbortController();
      controllerRef.current = controller;
      setConnectState({ status: "pending" });
      try {
        await fetchViewerLogin(value, controller.signal);
        if (controller.signal.aborted) return;
        setConnectState({ status: "idle" });
        setTokenInput("");
        props.onSubmitToken(value);
      } catch (error) {
        if (controller.signal.aborted) return;
        setConnectState({
          status: "error",
          message:
            error instanceof GitHubError
              ? error.message
              : "Could not verify this token with GitHub.",
        });
      }
    }

    function handleClear() {
      setConnectState({ status: "idle" });
      props.onClearToken();
    }

    return (
      <section className="beacon-settings" aria-label="PR Beacon settings">
        <div className="beacon-settings-intro">
          <h2>Set up PR Beacon</h2>
          <p className="beacon-muted">
            Connect GitHub to see your pull requests. Everything else is
            optional.
          </p>
        </div>
        {props.saveError && (
          <p role="alert">
            Couldn't save your preferences: {props.saveError}. Changes apply for
            this session but won't persist across reload.
          </p>
        )}
        <div className="beacon-card beacon-settings-card">
          <div className="beacon-section-heading">
            <h3>Connect GitHub</h3>
            <span className="beacon-badge beacon-accent">Required</span>
          </div>
          {props.hasToken ? (
            <p>
              Token loaded for this session. Repository access depends on its
              permissions.{" "}
              <button type="button" onClick={handleClear}>
                Disconnect
              </button>
            </p>
          ) : (
            <form
              onSubmit={handleConnect}
              aria-busy={connectState.status === "pending"}
            >
              <ol className="beacon-setup-steps">
                <li>
                  <a
                    href="https://github.com/settings/personal-access-tokens/new?name=PR%20Beacon&contents=read&pull_requests=write&checks=read&statuses=read"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Create a GitHub token
                  </a>
                  . Choose the account or organization that owns your
                  repositories, select the repositories to review, and set an
                  expiration.
                </li>
                <li>
                  Review the suggested repository permissions:
                  <ul className="beacon-token-permissions">
                    <li>
                      <strong>Pull requests: Read and write</strong> — view and
                      approve PRs
                    </li>
                    <li>
                      <strong>Contents: Read-only</strong> — view code diffs
                    </li>
                    <li>
                      <strong>Checks and Commit statuses: Read-only</strong> —
                      read check results
                    </li>
                  </ul>
                </li>
                <li>Generate the token, copy it, and paste it below.</li>
              </ol>
              <label>
                GitHub token
                <input
                  type="password"
                  autoComplete="off"
                  placeholder="Paste your GitHub token"
                  value={tokenInput}
                  disabled={connectState.status === "pending"}
                  onChange={(event) => {
                    setTokenInput(event.target.value);
                    if (connectState.status === "error")
                      setConnectState({ status: "idle" });
                  }}
                />
              </label>
              {connectState.status === "error" && (
                <p role="alert">{connectState.message}</p>
              )}
              <button
                className="beacon-primary"
                type="submit"
                disabled={
                  !tokenInput.trim() || connectState.status === "pending"
                }
              >
                {connectState.status === "pending"
                  ? "Connecting…"
                  : "Connect GitHub"}
              </button>
              <p className="beacon-muted beacon-token-note">
                Kept in memory only. Re-enter it after reloading Buzz or
                re-enabling this plugin. Connecting checks your GitHub identity;
                repository permissions are checked when used.
              </p>
              <details className="beacon-token-help">
                <summary>Need help accessing your repositories?</summary>
                <p>
                  Your organization may need to approve the token before private
                  repositories appear. Fine-grained tokens cover one repository
                  owner. For multiple organizations or outside-collaborator
                  access, see{" "}
                  <a
                    href="https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens"
                    target="_blank"
                    rel="noreferrer"
                  >
                    GitHub’s token guide
                  </a>
                  .
                </p>
              </details>
            </form>
          )}
        </div>
        <div className="beacon-card beacon-settings-card">
          <div className="beacon-section-heading">
            <h3>Highlight review requests</h3>
            <span className="beacon-badge">Optional</span>
          </div>
          <p className="beacon-muted">
            Highlight requests from these people or with these labels. Separate
            multiple entries with commas; leave blank to skip.
          </p>
          <label>
            VIP GitHub usernames
            <input
              type="text"
              placeholder="octocat, hubot"
              value={vipInput}
              onChange={(event) => setVipInput(event.target.value)}
              onBlur={() =>
                props.onChangePreferences({
                  ...props.preferences,
                  vipLogins: parseList(vipInput),
                })
              }
            />
          </label>
          <label>
            Watched labels
            <input
              type="text"
              placeholder="urgent, security"
              value={labelInput}
              onChange={(event) => setLabelInput(event.target.value)}
              onBlur={() =>
                props.onChangePreferences({
                  ...props.preferences,
                  watchedLabels: parseList(labelInput),
                })
              }
            />
          </label>
          <p className="beacon-muted">
            Saved automatically when you leave a field.
          </p>
        </div>
        <div className="beacon-card beacon-settings-card">
          <div className="beacon-section-heading">
            <h3>Automatic refresh</h3>
            <span className="beacon-badge">Optional</span>
          </div>
          <label className="beacon-checkbox">
            <input
              type="checkbox"
              checked={props.preferences.pollingEnabled}
              onChange={(event) =>
                props.onChangePreferences({
                  ...props.preferences,
                  pollingEnabled: event.target.checked,
                })
              }
            />
            Auto-refresh every minute while this page is open
          </label>
        </div>
      </section>
    );
  };
}

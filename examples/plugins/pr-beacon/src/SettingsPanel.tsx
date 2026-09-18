import type { Context } from "@buzz/author";
import type { Preferences } from "./preferences";

type ReactRuntime = Context["react"];

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

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
    const [vipInput, setVipInput] = React.useState(
      props.preferences.vipLogins.join(", "),
    );
    const [labelInput, setLabelInput] = React.useState(
      props.preferences.watchedLabels.join(", "),
    );

    return (
      <section aria-label="PR Beacon settings">
        <h2>Settings</h2>
        {props.saveError && (
          <p role="alert">
            Couldn't save your preferences: {props.saveError}. Changes apply for
            this session but won't persist across reload.
          </p>
        )}
        <div>
          <p>
            GitHub personal access token. Kept in memory for this session only —
            never saved to disk, never logged. You'll re-enter it each time you
            enable this plugin or reload Buzz.
          </p>
          {props.hasToken ? (
            <p>
              Token loaded for this session.{" "}
              <button type="button" onClick={props.onClearToken}>
                Clear token
              </button>
            </p>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (tokenInput.trim()) props.onSubmitToken(tokenInput.trim());
                setTokenInput("");
              }}
            >
              <label>
                GitHub token
                <input
                  type="password"
                  autoComplete="off"
                  value={tokenInput}
                  onChange={(event) => setTokenInput(event.target.value)}
                />
              </label>
              <button type="submit">Use token</button>
            </form>
          )}
        </div>
        <div>
          <label>
            VIP GitHub usernames (comma-separated)
            <input
              type="text"
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
        </div>
        <div>
          <label>
            Watched labels (comma-separated)
            <input
              type="text"
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
        </div>
        <div>
          <label>
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
            Refresh review requests and your pull requests automatically while
            this page is open (every minute)
          </label>
        </div>
      </section>
    );
  };
}

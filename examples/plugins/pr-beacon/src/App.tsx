import type { Context } from "@buzz/author";
import { classifyOwnPullRequest, isHighlighted } from "./classify";
import { createPullRequestDetailView } from "./PullRequestDetailView";
import { createSettingsPanel } from "./SettingsPanel";
import {
  GitHubError,
  fetchOwnPullRequests,
  fetchReviewRequests,
} from "./github";
import type { PreferencesStore } from "./preferences";
import type { AgentSummarySelection, RelayData } from "./relayTypes";
import type { TokenStore } from "./tokenStore";
import type {
  OwnPullRequest,
  OwnPullRequestStatus,
  PullRequestSummary,
  SearchResult,
} from "./types";

type ReactRuntime = Context["react"];

const OWN_STATUS_LABELS: Record<OwnPullRequestStatus, string> = {
  "ready-to-merge": "Ready to merge",
  "failing-checks": "Approved, checks failing",
  "needs-response": "Reviewed with feedback",
  "awaiting-review": "Awaiting review",
  draft: "Draft",
  unknown: "Unresolved",
};

// PR Beacon's own default poll interval.
const POLL_INTERVAL_MS = 60_000;

type LoadState<Item> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; items: Item[]; truncated: boolean };

function useTokenStore(React: ReactRuntime, tokenStore: TokenStore) {
  return React.useSyncExternalStore(
    tokenStore.subscribe,
    tokenStore.getToken,
    tokenStore.getToken,
  );
}

function usePreferencesStore(
  React: ReactRuntime,
  preferencesStore: PreferencesStore,
) {
  return React.useSyncExternalStore(
    preferencesStore.subscribe,
    preferencesStore.getPreferences,
    preferencesStore.getPreferences,
  );
}

function usePreferencesSaveError(
  React: ReactRuntime,
  preferencesStore: PreferencesStore,
) {
  return React.useSyncExternalStore(
    preferencesStore.subscribe,
    preferencesStore.getSaveError,
    preferencesStore.getSaveError,
  );
}

function useRelaySnapshot(React: ReactRuntime, relay: RelayData) {
  return React.useSyncExternalStore(
    relay.subscribe,
    relay.snapshot,
    relay.snapshot,
  );
}

export function createApp(
  React: ReactRuntime,
  tokenStore: TokenStore,
  preferencesStore: PreferencesStore,
  relay: RelayData,
) {
  const SettingsPanel = createSettingsPanel(React);
  const PullRequestDetailView = createPullRequestDetailView(React);

  function AgentSummarySettings(props: {
    relaySnapshot: ReturnType<RelayData["snapshot"]>;
    selection: AgentSummarySelection;
    onChangeSelection: (next: AgentSummarySelection) => void;
  }) {
    const session = props.relaySnapshot.session;
    const agentLibrarySnapshot = session.agentLibrary.snapshot();
    const channelListSnapshot = session.channels.list();
    const agentPubkey = props.selection?.agentPubkey ?? "";
    const channelId = props.selection?.channelId ?? "";

    return (
      <section aria-label="AI summary agent">
        <h3>AI summary agent</h3>
        <p>
          Pick an existing Buzz agent and a channel it's a member of. Sending a
          diff for a summary posts it as a normal channel message — every other
          member of that channel can read it too.
        </p>
        <div>
          <label>
            Summary agent
            <select
              value={agentPubkey}
              onChange={(event) =>
                props.onChangeSelection(
                  event.target.value
                    ? { agentPubkey: event.target.value, channelId }
                    : null,
                )
              }
            >
              <option value="">None selected</option>
              {agentLibrarySnapshot.identities.map((identity) => (
                <option key={identity.pubkey} value={identity.pubkey}>
                  {identity.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div>
          <label>
            Summary channel
            <select
              value={channelId}
              onChange={(event) =>
                props.onChangeSelection(
                  event.target.value && agentPubkey
                    ? { agentPubkey, channelId: event.target.value }
                    : null,
                )
              }
              disabled={!agentPubkey}
            >
              <option value="">None selected</option>
              {channelListSnapshot.channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
    );
  }

  // Shared by the review-request and own-pull-request lists: loads once,
  // exposes a manual refresh, and — only while pollingEnabled — re-loads on
  // a fixed interval as long as the component stays mounted. The interval
  // never starts a second request while one is already in flight.
  function usePolledFetch<Item>(
    token: string,
    pollingEnabled: boolean,
    fetcher: (
      token: string,
      signal: AbortSignal,
    ) => Promise<SearchResult<Item>>,
    fallbackErrorMessage: string,
  ): { state: LoadState<Item>; refresh: () => void } {
    const [state, setState] = React.useState<LoadState<Item>>({
      status: "loading",
    });
    const [reloadKey, setReloadKey] = React.useState(0);
    const isFetchingRef = React.useRef(false);

    React.useEffect(() => {
      const controller = new AbortController();
      isFetchingRef.current = true;
      setState({ status: "loading" });
      fetcher(token, controller.signal)
        .then((result) => {
          // Check ownership before touching the busy flag: an aborted
          // request's own callback must not clear the flag a newer,
          // still-in-flight request set, or a poll tick could start an
          // overlapping second request.
          if (controller.signal.aborted) return;
          isFetchingRef.current = false;
          setState({
            status: "ready",
            items: result.items,
            truncated: result.truncated,
          });
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          isFetchingRef.current = false;
          setState({
            status: "error",
            message:
              error instanceof GitHubError
                ? error.message
                : fallbackErrorMessage,
          });
        });
      return () => {
        controller.abort();
        isFetchingRef.current = false;
      };
    }, [token, reloadKey]);

    React.useEffect(() => {
      if (!pollingEnabled) return;
      const interval = setInterval(() => {
        if (isFetchingRef.current) return; // no overlapping requests
        setReloadKey((key) => key + 1);
      }, POLL_INTERVAL_MS);
      return () => clearInterval(interval);
    }, [pollingEnabled]);

    return { state, refresh: () => setReloadKey((key) => key + 1) };
  }

  function ReviewQueue(props: {
    token: string;
    vipLogins: string[];
    watchedLabels: string[];
    hiddenReviewRequestUrls: string[];
    pollingEnabled: boolean;
    onHiddenReviewRequestUrlsChange: (next: string[]) => void;
    onSelect: (pullRequest: PullRequestSummary) => void;
  }) {
    const { state, refresh } = usePolledFetch(
      props.token,
      props.pollingEnabled,
      fetchReviewRequests,
      "Could not load review requests.",
    );

    function hide(url: string) {
      if (props.hiddenReviewRequestUrls.includes(url)) return;
      props.onHiddenReviewRequestUrlsChange([
        ...props.hiddenReviewRequestUrls,
        url,
      ]);
    }
    function unhide(url: string) {
      props.onHiddenReviewRequestUrlsChange(
        props.hiddenReviewRequestUrls.filter((hiddenUrl) => hiddenUrl !== url),
      );
    }

    const hiddenSet = new Set(props.hiddenReviewRequestUrls);
    const visible =
      state.status === "ready"
        ? state.items.filter((item) => !hiddenSet.has(item.url))
        : [];
    const hidden =
      state.status === "ready"
        ? state.items.filter((item) => hiddenSet.has(item.url))
        : [];
    const highlighted = visible.filter((item) =>
      isHighlighted(item, props.vipLogins, props.watchedLabels),
    );
    const ordinary = visible.filter(
      (item) => !isHighlighted(item, props.vipLogins, props.watchedLabels),
    );

    return (
      <div>
        <button
          type="button"
          onClick={refresh}
          disabled={state.status === "loading"}
        >
          Refresh
        </button>
        {state.status === "loading" && <p>Loading review requests…</p>}
        {state.status === "error" && <p role="alert">{state.message}</p>}
        {state.status === "ready" && (
          <>
            {state.truncated && (
              <p role="alert">
                Showing the first {state.items.length} results; more may exist
                on GitHub. Refine your review-request filters on GitHub to see
                the rest.
              </p>
            )}
            {visible.length === 0 && <p>No open review requests.</p>}
            {highlighted.length > 0 && (
              <section aria-label="Highlighted review requests">
                <h3>Highlighted</h3>
                <ul>
                  {highlighted.map((item) => (
                    <li key={item.url}>
                      <button
                        type="button"
                        onClick={() => props.onSelect(item)}
                      >
                        {item.repository} #{item.number} — {item.title} (
                        {item.author})
                      </button>
                      <button type="button" onClick={() => hide(item.url)}>
                        Hide
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {ordinary.length > 0 && (
              <section aria-label="Review requests">
                <h3>Review requests</h3>
                <ul>
                  {ordinary.map((item) => (
                    <li key={item.url}>
                      <button
                        type="button"
                        onClick={() => props.onSelect(item)}
                      >
                        {item.repository} #{item.number} — {item.title} (
                        {item.author})
                      </button>
                      <button type="button" onClick={() => hide(item.url)}>
                        Hide
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {hidden.length > 0 && (
              <details aria-label={`Hidden review requests (${hidden.length})`}>
                <summary>Hidden review requests ({hidden.length})</summary>
                <ul>
                  {hidden.map((item) => (
                    <li key={item.url}>
                      {item.repository} #{item.number} — {item.title}
                      <button type="button" onClick={() => unhide(item.url)}>
                        Unhide
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    );
  }

  function OwnPullRequests(props: {
    token: string;
    pollingEnabled: boolean;
    onSelect: (pullRequest: PullRequestSummary) => void;
  }) {
    const { state, refresh } = usePolledFetch(
      props.token,
      props.pollingEnabled,
      fetchOwnPullRequests,
      "Could not load your pull requests.",
    );

    const grouped = new Map<OwnPullRequestStatus, OwnPullRequest[]>();
    if (state.status === "ready") {
      for (const item of state.items) {
        const status = classifyOwnPullRequest(item);
        grouped.set(status, [...(grouped.get(status) ?? []), item]);
      }
    }

    return (
      <div>
        <button
          type="button"
          onClick={refresh}
          disabled={state.status === "loading"}
        >
          Refresh
        </button>
        {state.status === "loading" && <p>Loading your pull requests…</p>}
        {state.status === "error" && <p role="alert">{state.message}</p>}
        {state.status === "ready" && (
          <>
            {state.truncated && (
              <p role="alert">
                Showing the first {state.items.length} pull requests; more may
                exist on GitHub.
              </p>
            )}
            {state.items.length === 0 && <p>You have no open pull requests.</p>}
            {(Object.keys(OWN_STATUS_LABELS) as OwnPullRequestStatus[]).map(
              (status) => {
                const items = grouped.get(status);
                if (!items?.length) return null;
                return (
                  <section key={status} aria-label={OWN_STATUS_LABELS[status]}>
                    <h3>{OWN_STATUS_LABELS[status]}</h3>
                    <ul>
                      {items.map((item) => (
                        <li key={item.url}>
                          <button
                            type="button"
                            onClick={() => props.onSelect(item)}
                          >
                            {item.repository} #{item.number} — {item.title}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              },
            )}
          </>
        )}
      </div>
    );
  }

  return function App() {
    const token = useTokenStore(React, tokenStore);
    const preferences = usePreferencesStore(React, preferencesStore);
    const preferencesSaveError = usePreferencesSaveError(
      React,
      preferencesStore,
    );
    const relaySnapshot = useRelaySnapshot(React, relay);
    const [summarySelection, setSummarySelection] =
      React.useState<AgentSummarySelection>(null);
    // A relay reconnect (or a community switch) invalidates any prior
    // selection: the same agent/channel ids can mean something different, or
    // nothing at all, on the other side of a generation change.
    React.useEffect(() => {
      setSummarySelection(null);
    }, [relaySnapshot.generation]);
    const [selected, setSelected] = React.useState<PullRequestSummary | null>(
      null,
    );
    const [tab, setTab] = React.useState<"review" | "own" | "settings">(
      token ? "review" : "settings",
    );

    if (selected && token)
      return (
        <section aria-label="PR Beacon">
          <button type="button" onClick={() => setSelected(null)}>
            Back
          </button>
          <PullRequestDetailView
            token={token}
            pullRequest={selected}
            relay={relay}
            relaySnapshot={relaySnapshot}
            summarySelection={summarySelection}
          />
        </section>
      );

    return (
      <section aria-label="PR Beacon" style={{ padding: 24 }}>
        <h1>PR Beacon</h1>
        <nav>
          <button
            type="button"
            onClick={() => setTab("review")}
            disabled={!token}
          >
            Review requests
          </button>
          <button type="button" onClick={() => setTab("own")} disabled={!token}>
            Your pull requests
          </button>
          <button type="button" onClick={() => setTab("settings")}>
            Settings
          </button>
        </nav>
        {tab === "settings" && (
          <SettingsPanel
            hasToken={Boolean(token)}
            onSubmitToken={(next) => {
              tokenStore.setToken(next);
              setTab("review");
            }}
            onClearToken={() => tokenStore.setToken(null)}
            preferences={preferences}
            onChangePreferences={preferencesStore.setPreferences}
            saveError={preferencesSaveError}
          />
        )}
        {tab === "settings" && (
          <AgentSummarySettings
            relaySnapshot={relaySnapshot}
            selection={summarySelection}
            onChangeSelection={setSummarySelection}
          />
        )}
        {tab === "review" &&
          (token ? (
            <ReviewQueue
              token={token}
              vipLogins={preferences.vipLogins}
              watchedLabels={preferences.watchedLabels}
              hiddenReviewRequestUrls={preferences.hiddenReviewRequestUrls}
              pollingEnabled={preferences.pollingEnabled}
              onHiddenReviewRequestUrlsChange={(next) =>
                preferencesStore.setPreferences({
                  ...preferences,
                  hiddenReviewRequestUrls: next,
                })
              }
              onSelect={setSelected}
            />
          ) : (
            <p>Add a GitHub token in Settings to see your review requests.</p>
          ))}
        {tab === "own" &&
          (token ? (
            <OwnPullRequests
              token={token}
              pollingEnabled={preferences.pollingEnabled}
              onSelect={setSelected}
            />
          ) : (
            <p>Add a GitHub token in Settings to see your pull requests.</p>
          ))}
      </section>
    );
  };
}

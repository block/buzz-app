import type { Context } from "@buzz/author";
import { beaconStyles } from "./styles";
import { classifyOwnPullRequest, isHighlighted } from "./classify";
import { createPullRequestDetailView } from "./PullRequestDetailView";
import { createSettingsPanel } from "./SettingsPanel";
import {
  GitHubError,
  fetchOwnPullRequests,
  fetchReviewRequests,
} from "./github";
import type { PreferencesStore } from "./preferences";
import type {
  AgentSummarySelection,
  RelayData,
  RelaySession,
} from "./relayTypes";
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

function useAgentLibrarySnapshot(
  React: ReactRuntime,
  agentLibrary: RelaySession["agentLibrary"],
) {
  return React.useSyncExternalStore(
    agentLibrary.subscribe,
    agentLibrary.snapshot,
    agentLibrary.snapshot,
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
    const agentLibrarySnapshot = useAgentLibrarySnapshot(
      React,
      session.agentLibrary,
    );
    const channelListSnapshot = session.channels.list();
    const agentPubkey = props.selection?.agentPubkey ?? "";
    const channelId = props.selection?.channelId ?? "";
    // Agent identities load asynchronously. Kick off a load whenever the
    // library hasn't started one on this session yet; the status-gated
    // dependency means this only fires once per idle state, never repeats
    // while loading/ready/error/unavailable, and re-fires on a fresh session
    // (relay reconnect) whose library starts idle again.
    React.useEffect(() => {
      if (agentLibrarySnapshot.status === "idle") {
        session.agentLibrary.refresh();
      }
    }, [session, agentLibrarySnapshot.status]);

    return (
      <section
        className="beacon-card beacon-settings-card"
        aria-label="AI summary agent"
      >
        <div className="beacon-section-heading">
          <h3>AI summaries with a Buzz agent</h3>
          <span className="beacon-badge">Optional</span>
        </div>
        <p>
          Review requests and approvals work without this. Pick an existing,
          running Buzz agent and a channel it's a member of to get AI-written PR
          summaries. Sending a diff for a summary posts it as a normal channel
          message — everyone else in that channel can read it too.
        </p>
        {agentLibrarySnapshot.status === "loading" && <p>Loading agents…</p>}
        {agentLibrarySnapshot.status === "error" && (
          <p role="alert">
            Could not load agents
            {agentLibrarySnapshot.error
              ? `: ${agentLibrarySnapshot.error}`
              : "."}{" "}
            <button
              type="button"
              onClick={() => session.agentLibrary.refresh()}
            >
              Retry
            </button>
          </p>
        )}
        {agentLibrarySnapshot.status === "unavailable" && (
          <p role="alert">Agents are unavailable in this Buzz build.</p>
        )}
        {agentLibrarySnapshot.status === "ready" &&
          agentLibrarySnapshot.identities.length === 0 && (
            <p>
              No Buzz agents are available yet. Ask your community administrator
              to connect an agent and add it to a channel you can use. You can
              review and approve pull requests without an agent.
            </p>
          )}
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
        {channelListSnapshot.channels.length === 0 && (
          <p>
            No channels are available. Join a channel with your agent in Buzz,
            then return here.
          </p>
        )}
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
        <p className="beacon-muted">
          When you open a pull request, choose Send diff to agent. Nothing is
          sent from Settings. Choose your agent and channel again after
          reconnecting or switching communities.
        </p>
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

  function PullRequestRow(props: {
    item: PullRequestSummary;
    onSelect: (item: PullRequestSummary) => void;
    onHide?: () => void;
    status?: OwnPullRequestStatus;
  }) {
    const { item } = props;
    return (
      <li className="beacon-pr-row">
        <span className="beacon-pr-symbol" aria-hidden="true">
          ↗
        </span>
        <button
          className="beacon-pr-link"
          type="button"
          aria-label={`${item.repository} #${item.number} — ${item.title} (${item.author})`}
          onClick={() => props.onSelect(item)}
        >
          <span className="beacon-pr-title">{item.title}</span>
          <span className="beacon-pr-meta">
            <span>{item.repository}</span>
            <span>#{item.number}</span>
            <span>by {item.author}</span>
          </span>
        </button>
        <span className="beacon-row-labels">
          {props.status && (
            <span className={`beacon-badge beacon-status-${props.status}`}>
              {OWN_STATUS_LABELS[props.status]}
            </span>
          )}
          {item.isDraft && !props.status && (
            <span className="beacon-badge">Draft</span>
          )}
          {item.labels.map((label) => (
            <span className="beacon-badge" key={label}>
              {label}
            </span>
          ))}
        </span>
        {props.onHide && (
          <button className="beacon-quiet" type="button" onClick={props.onHide}>
            Hide
          </button>
        )}
      </li>
    );
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
      <div className="beacon-inbox">
        <div className="beacon-toolbar">
          <p className="beacon-muted">
            {state.status === "ready"
              ? `${visible.length} open request${visible.length === 1 ? "" : "s"} for your review`
              : "Your review inbox"}
          </p>
          <button
            type="button"
            onClick={refresh}
            disabled={state.status === "loading"}
          >
            Refresh
          </button>
        </div>
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
                <h3 className="beacon-group-title">Highlighted</h3>
                <ul className="beacon-pr-list">
                  {highlighted.map((item) => (
                    <PullRequestRow
                      key={item.url}
                      item={item}
                      onSelect={props.onSelect}
                      onHide={() => hide(item.url)}
                    />
                  ))}
                </ul>
              </section>
            )}
            {ordinary.length > 0 && (
              <section aria-label="Review requests">
                <h3 className="beacon-group-title">Review requests</h3>
                <ul className="beacon-pr-list">
                  {ordinary.map((item) => (
                    <PullRequestRow
                      key={item.url}
                      item={item}
                      onSelect={props.onSelect}
                      onHide={() => hide(item.url)}
                    />
                  ))}
                </ul>
              </section>
            )}
            {hidden.length > 0 && (
              <details
                className="beacon-hidden"
                aria-label={`Hidden review requests (${hidden.length})`}
              >
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
      <div className="beacon-inbox">
        <div className="beacon-toolbar">
          <p className="beacon-muted">
            {state.status === "ready"
              ? `${state.items.length} open pull request${state.items.length === 1 ? "" : "s"}`
              : "Your open pull requests"}
          </p>
          <button
            type="button"
            onClick={refresh}
            disabled={state.status === "loading"}
          >
            Refresh
          </button>
        </div>
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
                    <h3 className="beacon-group-title">
                      {OWN_STATUS_LABELS[status]}
                    </h3>
                    <ul className="beacon-pr-list">
                      {items.map((item) => (
                        <PullRequestRow
                          key={item.url}
                          item={item}
                          onSelect={props.onSelect}
                          status={status}
                        />
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
        <section className="pr-beacon" aria-label="PR Beacon">
          <style>{beaconStyles}</style>
          <div className="beacon-workspace">
            <div className="beacon-backbar">
              <button
                className="beacon-quiet"
                type="button"
                onClick={() => setSelected(null)}
              >
                Back
              </button>
              <span aria-hidden="true">/</span>
              <span>PR Beacon</span>
            </div>
            <PullRequestDetailView
              token={token}
              pullRequest={selected}
              relay={relay}
              relaySnapshot={relaySnapshot}
              summarySelection={summarySelection}
            />
          </div>
        </section>
      );

    return (
      <section className="pr-beacon" aria-label="PR Beacon">
        <style>{beaconStyles}</style>
        <div className="beacon-workspace">
          <header className="beacon-header">
            <span className="beacon-mark" aria-hidden="true">
              <svg
                aria-hidden="true"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <circle cx="7" cy="5" r="2" />
                <circle cx="7" cy="19" r="2" />
                <circle cx="17" cy="19" r="2" />
                <path d="M7 7v10M17 17V9a4 4 0 0 0-4-4h-1m2-2-2 2 2 2" />
              </svg>
            </span>
            <div>
              <h1>PR Beacon</h1>
              <p className="beacon-muted">
                Review requests, changes, and agent summaries.
              </p>
            </div>
          </header>
          <nav className="beacon-tabs" aria-label="PR Beacon sections">
            <button
              type="button"
              onClick={() => setTab("review")}
              aria-current={tab === "review" ? "page" : undefined}
              disabled={!token}
            >
              Review requests
            </button>
            <button
              type="button"
              onClick={() => setTab("own")}
              aria-current={tab === "own" ? "page" : undefined}
              disabled={!token}
            >
              Your pull requests
            </button>
            <button
              type="button"
              onClick={() => setTab("settings")}
              aria-current={tab === "settings" ? "page" : undefined}
            >
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
        </div>
      </section>
    );
  };
}

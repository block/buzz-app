import { RefreshCw, Users } from "lucide-react";
import { Avatar } from "../../shared/Avatar";
import { avatarSource } from "../../shared/avatar-source";
import {
  groupAgentLibrary,
  type AgentLibrary,
} from "../../features/agents/library";
import { useEffect, useSyncExternalStore } from "react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { useRelayConnection } from "../../features/relay/react";

export function AgentsPage({ relay }: { relay: RelayData }) {
  const connection = useRelayConnection(relay);
  return (
    <section
      aria-label="Agents"
      className="h-full min-h-0 overflow-auto rounded-3xl border border-line bg-surface p-5 shadow-surface sm:p-8"
    >
      <h1 className="m-0 text-3xl font-medium tracking-tight">Agents</h1>
      {connection.status === "ready" ? (
        <MyAgents
          key={`${connection.scope}:${connection.generation}`}
          session={connection.session}
        />
      ) : (
        <div className="mt-6">
          <p>
            {connection.status === "connecting"
              ? "Connecting to your community…"
              : "Connect to a community to browse your agents."}
          </p>
          {connection.status === "error" && (
            <button type="button" onClick={() => relay.retry()}>
              Retry connection
            </button>
          )}
        </div>
      )}
    </section>
  );
}
function MyAgents({ session }: { session: RelaySession }) {
  const library = session.agentLibrary;
  const archives = session.archives;
  const snapshot = useSyncExternalStore(
    library.subscribe,
    library.snapshot,
    library.snapshot,
  );
  const archive = useSyncExternalStore(
    archives.subscribe,
    archives.snapshot,
    archives.snapshot,
  );
  const refresh = () => {
    void library.refresh();
    void archives.refresh();
  };
  useEffect(() => {
    void library.refresh();
    void archives.refresh();
  }, [library, archives]);
  const { groups, custom, unknown } = groupAgentLibrary(
    snapshot,
    (key) => archives.state(key) === "archived",
  );
  const loading = snapshot.status === "loading";
  return (
    <div className="mx-auto mt-2 max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 text-sm text-muted">Your agents from Buzz.</p>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-lg border-0 bg-soft px-3 py-2 text-xs"
          disabled={loading || snapshot.status === "unavailable"}
          onClick={refresh}
        >
          <RefreshCw size={14} aria-hidden="true" />
          {snapshot.status === "error" ? "Retry" : "Refresh agents"}
        </button>
      </div>
      {loading && <p role="status">Reading your Buzz library…</p>}
      {snapshot.status === "idle" && (
        <p role="status">Library cleared. Refresh to read it again.</p>
      )}
      {snapshot.status === "unavailable" && (
        <p role="status">
          The current Buzz library is available through the local live
          development host. See README for live setup.
        </p>
      )}
      {snapshot.error && <p role="alert">{snapshot.error}</p>}
      {snapshot.status === "ready" && (
        <>
          <section aria-label="My agents" className="space-y-3">
            <h2 className="m-0 flex items-center gap-2 text-sm font-semibold">
              My agents{" "}
              <span className="rounded-md bg-soft px-2 py-0.5 text-xs font-normal text-muted">
                {groups.length}
              </span>
            </h2>
            {!groups.length && (
              <p className="py-8 text-center text-sm text-muted">
                No selected agents in your Buzz library.
              </p>
            )}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))] gap-4">
              {groups.map((group) => (
                <AgentCard
                  key={group.id}
                  name={group.name}
                  avatar={group.avatar ?? group.identities[0]?.avatar}
                  identities={group.identities}
                  session={session}
                />
              ))}
            </div>
          </section>
          {!!custom.length && (
            <section aria-label="Custom agents" className="space-y-3">
              <h2 className="m-0 text-sm font-semibold">Custom agents</h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))] gap-4">
                {custom.map((identity) => (
                  <AgentCard
                    key={identity.pubkey}
                    name={identity.name}
                    avatar={identity.avatar}
                    identities={[identity]}
                    session={session}
                  />
                ))}
              </div>
            </section>
          )}
          {!!unknown.length && (
            <section aria-label="Unknown agents" className="space-y-3">
              <h2 className="m-0 text-sm font-semibold">Other identities</h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))] gap-4">
                {unknown.map((identity) => (
                  <AgentCard
                    key={identity.pubkey}
                    name={identity.name}
                    avatar={identity.avatar}
                    identities={[identity]}
                    session={session}
                  />
                ))}
              </div>
            </section>
          )}
          {archive.status !== "ready" && (
            <p className="text-sm text-muted">
              Archive visibility is unknown. Library entries remain visible;
              this does not grant channel access.
            </p>
          )}
          <p className="border-t border-line pt-4 text-xs text-muted">
            Mention existing members with @ in a channel or thread. This is your
            current Buzz library, read-only; keep Buzz running for replies.
          </p>
        </>
      )}
    </div>
  );
}
function AgentCard({
  name,
  avatar,
  identities,
  session,
}: {
  name: string;
  avatar?: string | undefined;
  identities: AgentLibrary["identities"];
  session: RelaySession;
}) {
  const source = avatarSource(avatar);
  const picture = source?.startsWith("data:")
    ? source
    : source
      ? session.media(source)
      : undefined;
  return (
    <article className="flex min-w-0 flex-col rounded-2xl border border-line bg-soft/70 p-4">
      <div className="flex min-h-36 flex-1 items-center justify-center py-5">
        <Avatar
          name={name}
          src={picture}
          className="size-24 rounded-[28px] border-[3px] border-surface text-3xl shadow-sm"
        />
      </div>
      <h3 className="m-0 truncate text-sm font-semibold" title={name}>
        {name}
      </h3>
      {identities.length ? (
        <details className="mt-1 text-xs text-muted">
          <summary
            className="flex cursor-pointer list-none items-center gap-1.5 py-1 hover:text-ink"
            aria-label={`Show identities for ${name}`}
          >
            <Users size={13} aria-hidden="true" />
            {identities.length}{" "}
            {identities.length === 1 ? "identity" : "identities"}
          </summary>
          <ul className="mt-2 space-y-3 border-t border-line pt-3">
            {identities.map((identity) => (
              <li key={identity.pubkey}>
                <span className="font-medium text-ink">{identity.name}</span>
                <p className="m-0 mt-1 select-all break-all font-mono text-[10px]">
                  {identity.pubkey}
                </p>
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <p className="m-0 mt-1 text-xs text-muted">No linked identity</p>
      )}
    </article>
  );
}

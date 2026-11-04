import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { avatarMedia } from "../../shared/avatar-source";
import { Button } from "../../shared/design-system/ui/Button";
import { Select } from "../../shared/design-system/ui/Select";
import type { ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { useAgentOwnerEvidence } from "../profiles/useAgentOwnerEvidence";
import messages from "../messages/Messages.module.css";
import { AgentsContext, useAgents, useAgent } from "./react";
import type { PortableAgent } from "./native";
import type { Agents, RegisteredAgentType } from "./service";

export function connectionDraft(
  candidate: PortableAgent,
  types: readonly RegisteredAgentType[],
): { type: string; config: unknown } | undefined {
  const saved = candidate.connection;
  if (!saved) return undefined;
  for (const type of types) {
    if (type.remote) continue;
    const config = type.importShared?.({ ...saved, model: saved.model ?? "" });
    if (config === undefined) continue;
    return {
      type: type.key,
      config:
        saved.effort &&
        typeof config === "object" &&
        config !== null &&
        "effort" in config
          ? { ...config, effort: saved.effort }
          : config,
    };
  }
  return undefined;
}

/** A local setup message: never a relay event or an agent-authored response. */
export function AgentConnectionSetup({
  session,
  channel,
}: {
  session: RelaySession;
  channel: ChannelSummary | undefined;
}) {
  const agents = useContext(AgentsContext);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const members = [...new Set(channel?.members ?? [])];
  const peer =
    channel?.channelType === "dm" &&
    !channel.archived &&
    channel.viewerRole !== "guest" &&
    members.length === 2 &&
    members.includes(session.viewer ?? "")
      ? members.find((key) => key !== session.viewer)
      : undefined;
  if (
    agents &&
    channel?.channelType === "dm" &&
    import.meta.env.DEV &&
    import.meta.env.VITE_AGENT_CONNECTION_PREVIEW === "1"
  )
    return (
      <AgentConnectionForm
        key={`preview:${channel.id}`}
        agents={agents}
        scope={session.scope}
        preview
        candidate={{
          source: "installed",
          pubkey: peer ?? "preview",
          name: (peer && profiles.get(peer)?.name) || channel.name,
          picture:
            avatarMedia(
              peer ? profiles.get(peer)?.picture : undefined,
              session.media,
            ) ?? "",
          relay: "",
        }}
      />
    );
  if (!agents || !peer) return null;
  return (
    <Candidate
      key={`${session.scope}:${peer}`}
      agents={agents}
      session={session}
      peer={peer}
    />
  );
}

function Candidate({
  agents,
  session,
  peer,
}: {
  agents: Agents;
  session: RelaySession;
  peer: string;
}) {
  const owned = useAgentOwnerEvidence(session, peer);
  const existing = useAgent(agents, peer)?.agent.key;
  const choices = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
  );
  const presence = useSyncExternalStore(
    (listener) => session.presence.subscribe(peer, listener),
    () => session.presence.status(peer),
  );
  const [candidate, setCandidate] = useState<PortableAgent>();
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (owned.status !== "ready" || owned.owner !== session.viewer || existing)
      return;
    let active = true;
    void agents
      .portable()
      .then((found) => {
        if (active)
          setCandidate(
            found.agents.find(
              (agent) =>
                agent.pubkey === peer && agent.connection?.runtime !== "hosted",
            ),
          );
      })
      .catch(() => {
        /* The existing Agents import page owns inventory recovery. */
      });
    return () => {
      active = false;
    };
  }, [agents, peer, owned.status, owned.owner, session.viewer, existing]);
  // Keep the result visible while import republishes the profile and inventory.
  if (
    !candidate ||
    (!started &&
      (existing ||
        owned.status !== "ready" ||
        owned.owner !== session.viewer ||
        presence === "online" ||
        presence === "away" ||
        choices.identities.some(
          (agent) =>
            agent.pubkey === peer && (agent.managed || agent.messageable),
        )))
  )
    return null;
  return (
    <AgentConnectionForm
      agents={agents}
      candidate={candidate}
      scope={session.scope}
      onStart={() => setStarted(true)}
    />
  );
}

const noSubscribe = () => () => {};
const ready = () => undefined;
export function AgentConnectionForm({
  agents,
  candidate,
  scope,
  onStart,
  preview = false,
}: {
  agents: Agents;
  candidate: PortableAgent;
  scope: string;
  onStart?: () => void;
  preview?: boolean;
}) {
  const { types } = useAgents(agents);
  const [draft, setDraft] = useState(() => connectionDraft(candidate, types));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const type = types.find((type) => type.key === draft?.type && !type.remote);
  const provider = type?.provider;
  const state = useSyncExternalStore(
    provider?.subscribe ?? noSubscribe,
    provider?.snapshot ?? ready,
  );
  useEffect(() => {
    void Promise.resolve(provider?.check()).catch(() => {});
  }, [provider]);
  const Model = type?.CreateModel;
  const connect = async () => {
    if (!type || !draft || pending) return;
    if (preview) {
      setError("Preview only. No agent was imported.");
      return;
    }
    setPending(true);
    onStart?.();
    setError("");
    try {
      const result = await agents.port({
        source: candidate.source,
        pubkey: candidate.pubkey,
        type: type.key,
        config: draft.config,
        scope,
      });
      if (result.notes.length) setError(result.notes.join(" "));
      setDone(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };
  return (
    <section aria-label="Agent connection setup" data-agent-connection-setup="">
      <div className={messages.message}>
        <div className={messages.messageBody}>
          <div className="w-full max-w-xl">
            <div className={messages.messageBubble}>
              <div className="flex flex-col gap-4 py-2">
                <div className="size-12">
                  <Avatar
                    src={candidate.picture}
                    fallback={candidate.name}
                    alt=""
                    shape="squircle"
                    size="fill"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <h3 className="m-0 text-label">
                    {done
                      ? `${candidate.name} connected`
                      : `Connect ${candidate.name}`}
                  </h3>
                  <p className="m-0 text-body-sm text-subtle">
                    {preview
                      ? "Choose a harness to import this agent."
                      : done
                        ? "Send a message to continue your conversation."
                        : draft
                          ? "Review the settings to import this agent and continue your conversation."
                          : "Choose a harness for this agent. Its previous harness is not available here."}
                    {!done &&
                      " Stop this agent in old Buzz before connecting, so only one app replies."}
                  </p>
                </div>
                {!done && (
                  <>
                    <div className="flex max-w-full flex-col items-start gap-3">
                      <Select
                        label="Harness"
                        variant="compact"
                        appearance="inverted"
                        size="sm"
                        placeholder="Choose harness"
                        value={type?.key ?? ""}
                        disabled={pending}
                        onValueChange={(key) => {
                          const selected = types.find(
                            (type) => type.key === key,
                          );
                          if (selected)
                            setDraft(
                              connectionDraft(candidate, [selected]) ?? {
                                type: key,
                                config: selected.defaults().config,
                              },
                            );
                          setError("");
                        }}
                        groups={[
                          {
                            label: "",
                            options: types
                              .filter((type) => !type.remote)
                              .map((type) => ({
                                value: type.key,
                                label: type.title,
                              })),
                          },
                        ]}
                      />
                      {Model && draft && (
                        <Model
                          modelAppearance="inverted"
                          showEffort={false}
                          config={draft.config}
                          disabled={pending}
                          onChange={(config) => setDraft({ ...draft, config })}
                        />
                      )}
                    </div>
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="prominent"
                        disabled={
                          pending ||
                          !type ||
                          (!!provider && state?.readiness !== "ready")
                        }
                        onClick={() => void connect()}
                      >
                        {pending ? "Connecting…" : "Connect"}
                      </Button>
                    </div>
                  </>
                )}
                {error && (
                  <p role="alert" className="m-0 text-body-sm text-danger">
                    {error}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

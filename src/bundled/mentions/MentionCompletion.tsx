import { mentionChoices } from "./mention-choices";
import { useIdentityNames } from "../../features/identity-names/react";
import { useMentionAgents } from "../../features/agents/mention-context";
import { useAgentChoices } from "./use-agent-choices";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ComposerCompletionProps } from "../../features/conversation/contracts";
import type { RelaySession } from "../../features/relay/session";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { useKnownAgentPubkeys } from "../../features/agents/use-known";
import { matchesMentionQuery } from "./mention-query";

// Demand bookkeeping only, not another profile cache. Missing names do not issue
// the same network request on every query keystroke; explicit retry remains available.
const demands = new WeakMap<RelaySession, Set<string>>();
export function MentionCompletion({
  session,
  scope,
  channelId,
  inviteAgents,
  query,
  publish,
}: ComposerCompletionProps) {
  const resolveName = useIdentityNames(session.names);
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const agents = useAgentChoices(session, inviteAgents);
  const agentPubkeys = useKnownAgentPubkeys(session, profiles);
  const channel = list.channels.find((item) => item.id === channelId);
  const { agents: localAgents } = useMentionAgents(scope);
  const available = useMemo(
    () =>
      !inviteAgents &&
      channel?.members &&
      !channel.archived &&
      (channel.channelType === "stream" || channel.channelType === "forum") &&
      session.outbox?.supports(9000)
        ? localAgents
            .filter((agent) => !channel.members?.includes(agent.pubkey))
            .map(({ pubkey, name }) => ({ pubkey, name }))
        : [],
    [channel, localAgents, session.outbox, inviteAgents],
  );
  const parentAdmission =
    !!channel &&
    (channel.channelType !== "session" || !!channel.parentChannelId);
  const members = channel?.members ?? [];
  const memberKey = members.join(":");
  const [attempt, retry] = useState(0);
  const [error, setError] = useState(false);
  useEffect(() => {
    session.channels.ensureList();
    const requested = demands.get(session) ?? new Set<string>();
    demands.set(session, requested);
    const ids = memberKey
      .split(":")
      .filter((id) => id && (attempt > 0 || !requested.has(id)))
      .slice(0, attempt > 0 ? 1024 : Math.max(0, 1024 - requested.size));
    if (!ids.length) return;
    for (const id of ids) requested.add(id);
    let live = true;
    void session.profiles.ensure(ids, "background").catch(() => {
      if (live) setError(true);
    });
    return () => {
      live = false;
    };
  }, [session, memberKey, attempt]);
  useEffect(() => {
    const members = memberKey ? memberKey.split(":") : [];
    const candidates = mentionChoices(
      [...agents.identities, ...available],
      members,
      profiles,
      resolveName,
    );
    const needle = query.query.toLowerCase();
    // Source names close completed mentions; display labels still admit multi-word searches.
    const admitted = matchesMentionQuery(
      query.query,
      candidates.flatMap(({ recipient, label }) => [recipient.name, label]),
    );
    const matching =
      admitted && !channel?.archived
        ? candidates
            .filter(({ recipient, label }) =>
              `${label} ${recipient.pubkey}`.toLowerCase().includes(needle),
            )
            .sort(
              (a, b) =>
                Number(!a.label.toLowerCase().startsWith(needle)) -
                  Number(!b.label.toLowerCase().startsWith(needle)) ||
                a.label.localeCompare(b.label) ||
                a.recipient.pubkey.localeCompare(b.recipient.pubkey),
            )
        : [];
    const membershipMissing = (!inviteAgents || !!channel) && !channel?.members;
    const missing = members.some((key) => !profiles.has(key));
    const withdraw = publish({
      items: matching.slice(0, 20).map(({ recipient, label }) => ({
        id: recipient.pubkey,
        label,
        detail: members.includes(recipient.pubkey)
          ? recipient.pubkey
          : inviteAgents
            ? `${parentAdmission ? "Adds to session and parent channel" : "Adds to session"} · ${recipient.pubkey}`
            : "Adds to channel when you send",
        preview: (
          <Avatar
            alt=""
            fallback={label}
            src={session.media(
              profiles.get(recipient.pubkey)?.picture ?? "",
              "small",
            )}
            size="small"
            shape={
              agentPubkeys.has(recipient.pubkey) ||
              !members.includes(recipient.pubkey)
                ? "squircle"
                : "circle"
            }
          />
        ),
        edit: { mention: recipient },
      })),
      ...(agents.status === "error"
        ? { status: "Could not load agents. Retry to refresh." }
        : admitted && membershipMissing
          ? { status: "Channel membership unavailable." }
          : admitted && list.error
            ? { status: "Could not refresh channel membership." }
            : error || missing
              ? {
                  status:
                    "Some names unavailable. Exact public keys still identify recipients.",
                }
              : matching.length > 20
                ? { status: "Narrow your search to see more members." }
                : {}),
      ...(agents.status === "error" ||
      membershipMissing ||
      list.error ||
      error ||
      missing
        ? {
            retry: () => {
              if (inviteAgents) void session.agentLibrary.refresh();
              setError(false);
              retry((value) => value + 1);
              if (membershipMissing || list.error)
                session.channels.refreshList?.();
            },
          }
        : {}),
    });
    // Invalidate displayed choices synchronously, before React paints new data.
    const revoke = () => {
      if (withdraw) withdraw();
    };
    const rosterChanged = session.channels.subscribeList(() => {
      const next = session.channels.list();
      // Other channels' previews and list loading notifications are not new
      // evidence for this menu. Revoke only what the effect will republish.
      if (
        next.channels.find((item) => item.id === channelId) !== channel ||
        next.error !== list.error
      )
        revoke();
    });
    const profilesChanged = session.profiles.subscribe(() => {
      if (session.profiles.snapshot() !== profiles) revoke();
    });
    const namesChanged = session.names.subscribe(revoke);
    const agentsChanged = inviteAgents
      ? session.agentLibrary.subscribe(revoke)
      : () => {};
    return () => {
      namesChanged();
      agentsChanged();
      rosterChanged();
      profilesChanged();
      revoke();
    };
  }, [
    resolveName,
    session,
    agents,
    inviteAgents,
    channel,
    channelId,
    memberKey,
    available,
    parentAdmission,
    profiles,
    agentPubkeys,
    query.query,
    publish,
    error,
    list.error,
  ]);
  return null;
}

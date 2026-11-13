import { useEffect, useState, useSyncExternalStore } from "react";
import { useAgentChoices } from "../../features/agents/use-choices";
import { channelAgentChoices } from "../../features/agents/choices";
import { useChannelList } from "../../features/relay/react";
import type { RelaySession } from "../../features/relay/session";
import { reviewChannelMember } from "./access";

export function useReviewAgents(session: RelaySession, channel: string) {
  const choices = useAgentChoices(session, true, true);
  const list = useChannelList(session.channels);
  const profiles = session.profiles;
  useSyncExternalStore(profiles.subscribe, profiles.snapshot);
  const selected = list.channels.find((item) => item.id === channel);
  const members =
    list.status === "ready" &&
    selected &&
    reviewChannelMember(selected, session.viewer)
      ? (selected.members ?? [])
      : [];
  const keys = [
    ...new Set([
      ...members,
      ...choices.identities.map((agent) => agent.pubkey),
    ]),
  ]
    .sort()
    .join(":");
  useSyncExternalStore(profiles.subscribe, () =>
    keys
      .split(":")
      .map((key) => `${key}:${profiles.owner?.(key) ?? ""}`)
      .join(";"),
  );
  const [error, setError] = useState("");
  const generation = profiles.generation?.();
  // biome-ignore lint/correctness/useExhaustiveDependencies: A full profile-cache reset requires a new ensure.
  useEffect(() => {
    let active = true;
    setError("");
    const ids = keys ? keys.split(":") : [];
    if (ids.length > 2000) {
      setError("Too many channel identities to load reviewer choices.");
      return;
    }
    const release = profiles.reserve?.(ids.length);
    void profiles.ensure(ids).catch(() => {
      if (active)
        setError("Could not verify agent owners. Reload to try again.");
    });
    return () => {
      active = false;
      release?.();
    };
  }, [profiles, keys, generation]);
  const scoped = channelAgentChoices(choices, members, profiles);
  return error ? { ...scoped, selectable: [], error } : scoped;
}

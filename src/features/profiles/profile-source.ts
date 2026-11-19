import { useSyncExternalStore, useContext, useMemo } from "react";
import { ProfileProvidersContext } from "./provider-context";
import type { ProfileProvider } from "./providers";
import { splitPartition } from "../relay/partition";
import type { RelaySession } from "../relay/session";
import type { Communities, PersonalProfile } from "../communities/service";
import type { profileFromEvent } from "../communities/api";
import {
  hasEventProof,
  newer,
  type EventData,
  type RelayEvent,
} from "../relay/events";
import {
  verifiedProfile,
  verifiedProfileFilter,
  verifiedProfileSubject,
} from "../relay/verified-profile";
import { profileTimeZone } from "./local-time";
import { parseManagedProfile, type ManagedProfile } from "./managed-profile";
import type { ProfileProviders } from "./providers";
import {
  profileSaveGeneration,
  profileSavedSince,
  trackBackgroundProfileWrite,
} from "../communities/profile-saves";

export type ProfileSyncOptions = {
  session?: RelaySession | undefined;
  providers?: ProfileProviders | undefined;
  community: string;
  viewer: string;
  communities: Communities;
  read: Promise<readonly EventData[]>;
  inspect(): Promise<ReturnType<typeof profileFromEvent>>;
  publish(
    profile: PersonalProfile,
    existing: Record<string, unknown>,
    preserveExisting?: boolean,
  ): Promise<void>;
  signal?: AbortSignal;
  zone: string | undefined;
};

const noSubscribe = () => () => {};
const emptyProviders: readonly (ProfileProvider & { key: string })[] = [];
/** Display data is read from the person's ordinary signed profile, not identity claims. */
export function useManagedProfile(
  session: RelaySession | undefined,
  pubkey: string,
): ManagedProfile | undefined {
  const registry = useContext(ProfileProvidersContext);
  const providers = useSyncExternalStore(
    registry?.subscribe ?? noSubscribe,
    registry?.snapshot ?? (() => emptyProviders),
  );
  const profile = useSyncExternalStore(
    session?.profiles.subscribe ?? noSubscribe,
    () => session?.profiles.snapshot().get(pubkey),
  );
  const event = useSyncExternalStore(
    session?.profiles.subscribe ?? noSubscribe,
    () => session?.profiles.event?.(pubkey),
  );
  return useMemo(() => {
    if (!providers.length) return;
    const identity = profile?.verified;
    const community = session && splitPartition(session.scope)?.communityOrigin;
    if (
      !community ||
      !session?.viewer ||
      identity?.status !== "checked" ||
      !identity.username ||
      !event
    )
      return;
    const subject = {
      community,
      viewer: session.viewer,
      pubkey,
      username: identity.username,
    };
    try {
      const metadata = JSON.parse(event.content);
      for (const provider of providers) {
        if (!provider.matches(subject)) continue;
        const saved = metadata.profile_extensions?.[provider.key];
        if (saved?.username !== subject.username) continue;
        const data = parseManagedProfile(JSON.stringify(saved.data));
        if (data) return data;
      }
    } catch {}
  }, [session, pubkey, profile, event, providers]);
}
export function useProfileCity(
  session: RelaySession,
  pubkey: string,
): string | undefined {
  return useManagedProfile(session, pubkey)?.city;
}
export function managedProfileTimeZone(
  data: ManagedProfile | undefined,
): boolean {
  return !!profileTimeZone(data?.timezone);
}
export function managedProfileFields(data: ManagedProfile | undefined) {
  const fields = data?.fields.filter(({ key }) => key !== "username") ?? [];
  const values = fields.map(({ key, label, value }) => ({
    key,
    label,
    value: value || "Not set",
  }));
  const timezone = profileTimeZone(data?.timezone);
  if (timezone && !fields.some(({ key }) => key === "timezone")) {
    values.push({
      key: "timezone",
      label: "Time zone",
      value: timezone,
    });
  }
  return values;
}
export function managedProfileHeading(data: ManagedProfile | undefined) {
  return data
    ? { title: `Managed by ${data.source_label}`, url: data.source_url }
    : undefined;
}
export function profilePhotoChoice(
  _community: string,
  existing: Record<string, unknown>,
  picture: string,
  removedManagedDefault = false,
): Record<string, unknown> {
  const before = typeof existing.picture === "string" ? existing.picture : "";
  return picture !== before || removedManagedDefault
    ? { ...existing, managed_photo_initialized: true }
    : existing;
}

/** Refresh only the current viewer. Existing metadata and foreground edits take precedence. */
export async function syncManagedProfile(
  options: ProfileSyncOptions,
): Promise<boolean | undefined> {
  const { providers, communities, viewer, signal } = options;
  const session = options.session;
  if (!providers?.snapshot().length || !session?.viewer) return undefined;
  const generation = profileSaveGeneration(communities);
  const authority = session.profiles.verifiedAuthority?.();
  const revision = session.profiles.verifiedRevision?.();
  const currentSession = () =>
    !signal?.aborted &&
    communities.relay.snapshot().session === session &&
    session.viewer === viewer &&
    session.profiles.verifiedAuthority?.() === authority &&
    session.profiles.verifiedRevision?.() === revision &&
    !profileSavedSince(communities, generation);
  try {
    await options.read;
    const readIdentity = async (includeProfile = false) => {
      if (!authority) return {};
      const events = await session.read(
        [
          {
            ...verifiedProfileFilter(authority.pubkey, [viewer]),
            consistency: "strong",
          },
          ...(includeProfile
            ? [
                {
                  kinds: [0],
                  authors: [viewer],
                  limit: 5,
                  consistency: "strong" as const,
                },
              ]
            : []),
        ],
        {
          fresh: true,
          signal: signal ?? AbortSignal.timeout(12000),
          priority: "background",
        },
      );
      let head: RelayEvent | undefined;
      let metadata: RelayEvent | undefined;
      for (const event of events) {
        if (!hasEventProof(event)) continue;
        const signed = event as RelayEvent;
        if (signed.kind === 0 && signed.pubkey === viewer)
          metadata = newer(metadata, signed);
        if (verifiedProfileSubject(signed, authority) === viewer)
          head = newer(head, signed);
      }
      return {
        identity: head ? verifiedProfile(head, authority, true) : undefined,
        metadata,
      };
    };
    const { identity } = await readIdentity();
    const community = splitPartition(session.scope)?.communityOrigin;
    if (!currentSession()) return false;
    if (!community || identity?.status !== "checked" || !identity.username)
      return undefined;
    const subject = {
      community,
      viewer,
      pubkey: viewer,
      username: identity.username,
    };
    const provider = providers.snapshot().find((p) => p.matches(subject));
    if (!provider) return undefined;
    const current = await options.inspect();
    if (!currentSession() || !providers.snapshot().includes(provider))
      return false;
    if (!current.exists || !current.profile.name.trim()) return false;
    const saved = current.existing.profile_extensions as
      | Record<string, unknown>
      | undefined;
    const savedEntry = saved?.[provider.key] as
      | { username?: string; data?: unknown }
      | undefined;
    const refreshKey = `buzz-profile-refresh.v1:${provider.key}:${community}:${viewer}:${identity.username}`;
    let last = 0;
    try {
      last = Number(localStorage.getItem(refreshKey)) || 0;
    } catch {}
    if (
      savedEntry?.username === identity.username &&
      parseManagedProfile(JSON.stringify(savedEntry.data)) &&
      last <= Date.now() &&
      Date.now() - last < 86400000
    )
      return false;
    const data = parseManagedProfile(
      JSON.stringify(
        await provider.refresh(subject, signal ?? AbortSignal.timeout(12000)),
      ),
    );
    if (!data || !currentSession() || !providers.snapshot().includes(provider))
      return false;
    const { identity: confirmedIdentity, metadata } = await readIdentity(true);
    const retained = session.profiles.event?.(viewer);
    if (
      !currentSession() ||
      !providers.snapshot().includes(provider) ||
      !metadata ||
      JSON.stringify(JSON.parse(metadata.content)) !==
        JSON.stringify(current.existing) ||
      (retained && newer(metadata, retained).id !== metadata.id)
    )
      return false;
    if (
      !currentSession() ||
      !providers.snapshot().includes(provider) ||
      confirmedIdentity?.username !== identity.username
    )
      return false;
    const entry = { username: identity.username, data };
    const importPhoto =
      current.existing.managed_photo_initialized !== true &&
      !current.profile.picture &&
      !!data.picture;
    const markPhoto =
      current.existing.managed_photo_initialized !== true &&
      (!!current.profile.picture || importPhoto);
    const zone = profileTimeZone(data.timezone);
    const updateZone = !!zone && current.existing.tz !== zone;
    if (
      JSON.stringify(savedEntry) !== JSON.stringify(entry) ||
      markPhoto ||
      updateZone
    ) {
      const write = options.publish(
        {
          ...current.profile,
          ...(importPhoto && data.picture ? { picture: data.picture } : {}),
        },
        {
          ...current.existing,
          ...(importPhoto && data.picture ? { picture: data.picture } : {}),
          ...(markPhoto ? { managed_photo_initialized: true } : {}),
          ...(updateZone ? { tz: zone } : {}),
          profile_extensions: { ...saved, [provider.key]: entry },
        },
        true,
      );
      trackBackgroundProfileWrite(communities, write);
      await write;
      const confirmed = await options.inspect();
      const extensions = confirmed.existing.profile_extensions as
        | Record<string, unknown>
        | undefined;
      if (
        !currentSession() ||
        JSON.stringify(extensions?.[provider.key]) !== JSON.stringify(entry) ||
        (importPhoto && confirmed.existing.picture !== data.picture) ||
        (markPhoto && confirmed.existing.managed_photo_initialized !== true) ||
        (updateZone && confirmed.existing.tz !== zone)
      )
        return false;
    }
    try {
      localStorage.setItem(refreshKey, String(Date.now()));
    } catch {}
    return true;
  } catch {
    return false;
  }
}

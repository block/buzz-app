import { useCallback, useEffect, useSyncExternalStore } from "react";
import { CHANNEL_DURATIONS } from "../../bundled/channels/ChannelDurationField";
import type { RelaySession } from "../relay/session";
import { readView, subscribeView, writeView } from "../../shared/view-state";

// Cached on this device for the account and community (the view scope). The
// account record is the source of truth: every install adopts it once per
// session, and a change made here is saved to both.
const KEY = "solo:default-lifetime";
const WORKSPACES = "solo:workspace-lifetimes";

type Account = NonNullable<RelaySession["accountSettings"]>;
const adopted = new WeakSet<Account>();
// Accounts changed here this session; a slower read no longer overwrites them.
const changed = new WeakSet<Account>();

const duration = (value: unknown) =>
  typeof value === "number" && CHANNEL_DURATIONS.includes(value)
    ? value
    : undefined;

/** The account default for new conversations: seconds without activity
 * before one archives, or undefined for ongoing. Only the durations a person
 * can choose are read; anything else is ongoing. */
export function readDefaultLifetime(scope: string): number | undefined {
  return duration(readView<unknown>(scope, KEY, null));
}

/** Workspaces with their own lifetime: seconds, or null for ongoing. */
function readWorkspaceLifetimes(
  scope: string,
): Readonly<Record<string, number | null>> {
  const saved = readView<unknown>(scope, WORKSPACES, null);
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  return Object.fromEntries(
    Object.entries(saved).flatMap(([id, value]) =>
      value === null || duration(value) !== undefined ? [[id, value]] : [],
    ),
  );
}

/** A workspace's own lifetime: undefined while it follows the default, null
 * for ongoing, else seconds. */
export function readWorkspaceLifetime(
  scope: string,
  workspace: string,
): number | null | undefined {
  const overrides = readWorkspaceLifetimes(scope);
  return Object.hasOwn(overrides, workspace) ? overrides[workspace] : undefined;
}

/** The lifetime a new conversation starts with: its workspace's own, else
 * the account default. Undefined is ongoing. */
export function effectiveLifetime(
  scope: string,
  workspace?: string | undefined,
): number | undefined {
  const own = workspace ? readWorkspaceLifetime(scope, workspace) : undefined;
  return own === undefined ? readDefaultLifetime(scope) : (own ?? undefined);
}

/** A draft's lifetime: the one its settings chose, else its workspace's. */
export function draftLifetime(
  scope: string,
  settings: { ttlSeconds?: number | undefined; lifetimeChosen?: true },
  workspace?: string | undefined,
): number | undefined {
  return settings.ttlSeconds !== undefined || settings.lifetimeChosen
    ? settings.ttlSeconds
    : effectiveLifetime(scope, workspace);
}

/** Adopts the account's saved lifetimes into this device's cache, once per
 * session. */
export function useAccountLifetimes(
  session: RelaySession | undefined,
  scope: string,
) {
  const account = session?.accountSettings;
  useEffect(() => {
    if (!account || adopted.has(account)) return;
    adopted.add(account);
    account.read().then(
      (saved) => {
        if (!saved || changed.has(account)) return;
        writeView(scope, KEY, saved.lifetime);
        writeView(scope, WORKSPACES, saved.workspaces);
      },
      // Unreadable: keep this device's cache and try again next session.
      () => adopted.delete(account),
    );
  }, [account, scope]);
}

const saveError = "Couldn’t save this. Try again.";

/** Saves the account default; resolves to an error message on failure. */
export async function saveDefaultLifetime(
  session: RelaySession | undefined,
  scope: string,
  ttlSeconds: number | undefined,
): Promise<string | undefined> {
  const account = session?.accountSettings;
  const cached = writeView(scope, KEY, ttlSeconds ?? null);
  if (!account)
    return cached ? undefined : "Couldn’t save this on this device. Try again.";
  changed.add(account);
  try {
    await account.writeLifetime(ttlSeconds ?? null);
    return undefined;
  } catch {
    return saveError;
  }
}

/** Saves a workspace's own lifetime, or undefined to follow the default;
 * resolves to an error message on failure. */
export async function saveWorkspaceLifetime(
  session: RelaySession | undefined,
  scope: string,
  workspace: string,
  lifetime: number | null | undefined,
): Promise<string | undefined> {
  const account = session?.accountSettings;
  const { [workspace]: _previous, ...others } = readWorkspaceLifetimes(scope);
  const cached = writeView(
    scope,
    WORKSPACES,
    lifetime === undefined ? others : { ...others, [workspace]: lifetime },
  );
  if (!account)
    return cached ? undefined : "Couldn’t save this on this device. Try again.";
  changed.add(account);
  try {
    await account.writeWorkspaceLifetime(workspace, lifetime);
    return undefined;
  } catch {
    return saveError;
  }
}

export function useDefaultLifetime(scope: string) {
  return useSyncExternalStore(
    useCallback((listener) => subscribeView(scope, listener, KEY), [scope]),
    () => readDefaultLifetime(scope),
  );
}

export function useWorkspaceLifetime(scope: string, workspace: string) {
  return useSyncExternalStore(
    useCallback(
      (listener) => subscribeView(scope, listener, WORKSPACES),
      [scope],
    ),
    () => readWorkspaceLifetime(scope, workspace),
  );
}

/** Saves the account default on this device only; false when it could not. */
export function writeDefaultLifetime(
  scope: string,
  ttlSeconds: number | undefined,
) {
  return writeView(scope, KEY, ttlSeconds ?? null);
}

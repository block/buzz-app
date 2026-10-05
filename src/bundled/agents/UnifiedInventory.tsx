import { archiveHides } from "../../features/relay/identity-archives";
import { InventoryView } from "./InventoryView";
import type { ClientSnapshot } from "../../features/communities/service";
import { useCommunityInventory } from "./use-community-inventory";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  AgentControl,
  AgentControlState,
  AgentView,
  ImportSource,
} from "../../features/agents/control";
import {
  communityDestination,
  relayOrigin,
} from "../../features/communities/destination";
import {
  useToastDismiss,
  useToastNotification,
} from "../../shared/design-system/ui/Toast";
import { useInventoryArchive } from "./inventory-archive";
import { useIdentityNames } from "../../features/identity-names/react";
import type { RelaySnapshot } from "../../features/relay/service";
import { Button } from "../../shared/design-system/ui/Button";
import { inventoryIdentities, localSetups } from "./inventory-model";
import { identityTiles } from "./identity-tiles";
import type { ProfileResolver } from "./AgentCard";
import { removeRelayAgent } from "../../features/agents/relay-removal";

/** Discovery, saved metadata and execution are facts of one exact public key. */
export function UnifiedInventory({
  state,
  control,
  connection,
  client,
  edit,
  duplicate,
  remove,
  importedId,
  resolveProfile,
  profileKeys,
  onUseHere,
  onImport,
}: {
  state: AgentControlState;
  control: AgentControl;
  connection: RelaySnapshot;
  client?: ClientSnapshot | undefined;
  edit(agent: AgentView, avatar?: string): void;
  duplicate?: ((agent: AgentView) => void) | undefined;
  remove?: ((agent: AgentView) => void) | undefined;
  importedId: string | null;
  resolveProfile?: ProfileResolver | undefined;
  profileKeys?: ReadonlySet<string> | undefined;
  onUseHere(
    pubkey: string,
    action: "use" | "clone",
    source?: ImportSource,
  ): void;
  onImport(pubkey: string, source?: ImportSource): void;
}) {
  const { agentLibrary: library, archives, profiles } = connection.session;
  const publicProfiles = useSyncExternalStore(
    profiles.subscribe,
    profiles.snapshot,
    profiles.snapshot,
  );
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
  // An archive re-read (Remove starts one) briefly reports every key as
  // unknown. Keep hiding the last confirmed archived set until it answers,
  // so archived agents do not flash back into the list.
  const lastArchived = useRef<ReadonlySet<string>>(new Set());
  if (archive.status === "ready")
    lastArchived.current = new Set(archive.archived);
  else if (archive.status !== "loading") lastArchived.current = new Set();
  const archived = (pubkey: string) =>
    archiveHides(
      archive.status === "loading"
        ? {
            state: (key) =>
              lastArchived.current.has(key) ? "archived" : "unknown",
          }
        : archives,
      pubkey,
      connection.viewer,
    );
  const resolveName = useIdentityNames(connection.session.names);
  useEffect(() => {
    if (connection.status === "ready") {
      void library.refresh();
      void archives.refresh();
    }
  }, [library, archives, connection.status]);
  const destination =
    connection.viewer && connection.scope?.endsWith(`:${connection.viewer}`)
      ? relayOrigin(connection.scope.slice(0, -(connection.viewer.length + 1)))
      : "";
  const [refresh, setRefresh] = useState(0);
  // Hide confirmed removals at once and for as long as this view lives. A
  // removal is per community, so the key includes the destination.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  // Archive is the first removal step and hides the row. Keep a started
  // removal's card in its starting section (true: Archived) until it
  // finishes, so its later steps and errors stay visible. Moving the card
  // would unmount Remove and cancel its own request.
  const [held, setHeld] = useState<ReadonlyMap<string, boolean>>(new Map());
  const communityName =
    client?.memberships.find((membership) => {
      try {
        return communityDestination(membership.id).url === destination;
      } catch {
        return false;
      }
    })?.name || (destination ? new URL(destination).host : "this community");
  const notify = useToastNotification();
  const dismiss = useToastDismiss();
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  // Undo belongs to this view and its archive session. Close open Undo
  // notices when either ends, so a stale Undo cannot start a request that
  // nobody can report.
  const undoNotices = useRef(new Set<string>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new community or session retires earlier Undo notices.
  useEffect(() => {
    const open = undoNotices.current;
    return () => {
      for (const id of open) dismissRef.current(id);
      open.clear();
    };
  }, [archives, destination]);
  const archiving = useInventoryArchive(
    archives,
    destination,
    (pubkey, action) => {
      const name = rows.get(pubkey)?.displayName ?? "Agent";
      const id = notify(
        `${name} ${action === "archive" ? "archived" : "unarchived"} in ${communityName}`,
        "success",
        action === "archive"
          ? {
              label: "Undo",
              onClick: () => {
                undoNotices.current.delete(id);
                void archiving.run(pubkey, "unarchive");
              },
            }
          : undefined,
      );
      if (action === "archive") undoNotices.current.add(id);
    },
  );
  const {
    communityIdentities,
    profiles: sourceProfiles,
    profileErrors,
    errors,
    pending,
    currentReadComplete,
  } = useCommunityInventory(connection, client, destination, refresh);
  const data = state.data;
  const selectedViewerMatches = !client || client.viewer === connection.viewer;
  const profileRequest = JSON.stringify({
    keys: [
      ...new Set([
        ...(selectedViewerMatches
          ? snapshot.identities.map((row) => row.pubkey)
          : []),
        ...(data?.parked ?? []).map((row) => row.pubkey),
        ...(data?.agents ?? []).map((row) => row.pubkey),
      ]),
    ].sort(),
    generation: connection.generation,
    refresh,
  });
  useEffect(() => {
    if (connection.status !== "ready" || !selectedViewerMatches) return;
    const { keys } = JSON.parse(profileRequest) as { keys: string[] };
    // Public profiles enrich display only; failed reads must not hide inventory.
    for (let offset = 0; offset < keys.length; offset += 500)
      void profiles
        .ensure(keys.slice(offset, offset + 500), "background")
        .catch(() => {});
  }, [profiles, profileRequest, connection.status, selectedViewerMatches]);
  if (!data) return null;
  const discovered = identityTiles(snapshot, () => false);
  const rows = inventoryIdentities(
    connection.status === "ready" && selectedViewerMatches
      ? discovered.identities
      : [],
    communityIdentities,
    data,
    (key, fallback) => sourceProfiles.get(key)?.name ?? fallback,
  );
  // Apply the shared archive rule after all discovery sources join. Archived
  // agents stay listed in their own section, so they can be unarchived. A card
  // keeps its place while its Remove request runs, and keeps its starting
  // section while an Archive or Unarchive request runs or shows its error.
  const archivedHere = new Set<string>();
  for (const row of rows.values()) {
    const key = `${destination} ${row.pubkey}`;
    const run = archiving.runs.get(row.pubkey);
    if (removed.has(key) && !row.localIdentity) rows.delete(row.pubkey);
    else if (
      run ? run.action === "unarchive" : (held.get(key) ?? archived(row.pubkey))
    )
      archivedHere.add(row.pubkey);
  }
  const viewer = connection.viewer;
  const removeRelay =
    connection.status === "ready" &&
    selectedViewerMatches &&
    viewer &&
    connection.session.outbox?.supports(5)
      ? async (pubkey: string, signal: AbortSignal) => {
          const key = `${destination} ${pubkey}`;
          const startedArchived = archivedHere.has(pubkey);
          setHeld((saved) =>
            saved.has(key) ? saved : new Map(saved).set(key, startedArchived),
          );
          // A failed removal stays held: the card shows the error and Retry.
          await removeRelayAgent(connection.session, viewer, pubkey, signal);
          setRemoved((saved) => new Set([...saved, key]));
          setHeld((saved) => {
            const next = new Map(saved);
            next.delete(key);
            return next;
          });
          // The removed set already hides the card. A community recheck here
          // would show its status lines above the list and shift the page.
          void library.refresh();
        }
      : undefined;
  const candidates = [...rows.keys()];
  const displayFacts = [...rows.values()].map((row) => ({
    pubkey: row.pubkey,
    name:
      (localSetups(row, destination)[0] ?? row.unconfiguredSetups[0])?.name ??
      row.displayName,
    isAgent: true,
  }));
  for (const fact of displayFacts) {
    const row = rows.get(fact.pubkey);
    if (row)
      row.displayName = resolveName(
        fact.pubkey,
        fact.name,
        candidates,
        displayFacts,
      );
  }
  return (
    <InventoryView
      state={state}
      control={control}
      session={connection.session}
      destination={destination}
      rows={rows}
      profiles={
        connection.status === "ready" && selectedViewerMatches
          ? discovered.profiles
          : []
      }
      publicProfiles={publicProfiles}
      sourceProfiles={sourceProfiles}
      edit={edit}
      duplicate={duplicate}
      remove={remove}
      removeRelay={removeRelay}
      archive={
        connection.status === "ready" && selectedViewerMatches && destination
          ? {
              archived: archivedHere,
              community: communityName,
              runs: archiving.runs,
              request: (pubkey, action) => void archiving.run(pubkey, action),
              focus: archiving.focus,
              attempt: refresh,
            }
          : undefined
      }
      importedId={importedId}
      resolveProfile={resolveProfile}
      profileKeys={profileKeys}
      onUseHere={onUseHere}
      onImport={onImport}
    >
      {data.inventoryWarnings?.map((warning) => (
        <p key={warning} role="alert">
          {warning} Retry local discovery by reopening the app.
        </p>
      ))}
      {(client?.status === "ready" || connection.status === "ready") && (
        <div className="self-start">
          <Button
            disabled={snapshot.status === "loading"}
            onClick={() => {
              void library.refresh();
              void archives.refresh();
              setRefresh((value) => value + 1);
            }}
          >
            Refresh agents
          </Button>
        </div>
      )}
      {pending && <p role="status">Checking community inventory…</p>}
      {profileErrors.map((community) => (
        <p key={community} role="alert">
          Agent names and pictures could not be checked for {community}. Refresh
          to retry.
        </p>
      ))}
      {errors.map((community) => (
        <p key={community} role="alert">
          Community inventory could not be checked for {community}. Refresh to
          retry.
        </p>
      ))}
      {!currentReadComplete && (
        <p role="status">
          Showing known community associations. Community checks are not
          current.
        </p>
      )}
      {snapshot.error && connection.status === "ready" && (
        <p role="alert">{snapshot.error}</p>
      )}
    </InventoryView>
  );
}

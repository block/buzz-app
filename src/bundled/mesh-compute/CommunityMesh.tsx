import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { communityDestination } from "../../features/communities/destination";
import type { RelayData } from "../../features/relay/service";
import { Button } from "../../shared/design-system/ui/Button";
import { formatPublicKey } from "../../shared/identity/public-key";

type Inventory = {
  unavailable: string | null;
  entries: {
    deviceId: string | null;
    memberPubkey: string;
    modelId: string;
    modelName: string | null;
    deviceName: string | null;
    vramGb: number | null;
  }[];
};

export function CommunityMesh({
  community,
  relay,
}: {
  community: string;
  relay: RelayData;
}) {
  const snapshot = useSyncExternalStore(relay.subscribe, relay.snapshot);
  const directory = snapshot.session.profiles;
  const profiles = useSyncExternalStore(
    directory.subscribe,
    directory.snapshot,
  );
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    snapshot: typeof snapshot;
    inventory?: Inventory;
    error?: string;
  }>();
  useEffect(() => {
    void attempt; // Manual refresh reruns this read, without a polling owner.
    let active = true;
    setResult(undefined);
    if (!isTauri()) return;
    void (async () => {
      try {
        const inventory = await invoke<Inventory>("mesh_compute_inventory", {
          community: communityDestination(community).url,
        });
        if (!active || snapshot !== relay.snapshot()) return;
        setResult({ snapshot, inventory });
        void directory
          .ensure(
            inventory.entries.map((entry) => entry.memberPubkey),
            "background",
          )
          .catch(() => {});
      } catch (error) {
        if (active && snapshot === relay.snapshot())
          setResult({ snapshot, error: String(error) });
      }
    })();
    return () => {
      active = false;
    };
  }, [community, snapshot, directory, relay, attempt]);
  const current = result?.snapshot === snapshot ? result : undefined;
  const inventory = current?.inventory;
  const error = current?.error ?? inventory?.unavailable;
  return (
    <section aria-label="Community mesh">
      <h2 className="text-body">Community mesh</h2>
      <p className="text-body-sm text-secondary">
        Signed community advertisements, not live connection health.
      </p>
      {!isTauri() ? (
        <p role="status">Open Buzz desktop to see community mesh.</p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : !inventory ? (
        <p role="status">Loading community mesh…</p>
      ) : inventory.entries.length === 0 ? (
        <p role="status">No one is sharing compute yet.</p>
      ) : (
        <ul>
          {inventory.entries.map((entry) => (
            <li
              key={`${entry.memberPubkey}:${entry.modelId}:${entry.deviceId}`}
              className="text-body"
            >
              {profiles.get(entry.memberPubkey)?.name ||
                formatPublicKey(entry.memberPubkey) ||
                "Unknown member"}
              {" — "}
              {entry.modelName || entry.modelId}
              {entry.deviceName && ` — ${entry.deviceName}`}
              {entry.vramGb != null && ` — ${entry.vramGb} GB advertised VRAM`}
            </li>
          ))}
        </ul>
      )}
      {isTauri() && (inventory || error) && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Refresh community mesh
        </Button>
      )}
    </section>
  );
}

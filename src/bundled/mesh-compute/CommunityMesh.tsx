import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { communityDestination } from "../../features/communities/destination";
import type { RelayData } from "../../features/relay/service";
import styles from "./Compute.module.css";
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
  refreshKey = 0,
}: {
  community: string;
  relay: RelayData;
  refreshKey?: number;
}) {
  const snapshot = useSyncExternalStore(relay.subscribe, relay.snapshot);
  const directory = snapshot.session.profiles;
  const profiles = useSyncExternalStore(
    directory.subscribe,
    directory.snapshot,
  );
  const [result, setResult] = useState<{
    snapshot: typeof snapshot;
    inventory?: Inventory;
    error?: string;
  }>();
  useEffect(() => {
    void refreshKey; // The page Refresh reruns this read, without a polling owner.
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
  }, [community, snapshot, directory, relay, refreshKey]);
  const current = result?.snapshot === snapshot ? result : undefined;
  const inventory = current?.inventory;
  const error = current?.error ?? inventory?.unavailable;
  const entries = inventory?.entries ?? [];
  const contributors = new Set(entries.map((entry) => entry.memberPubkey)).size;
  const modelCount = new Set(entries.map((entry) => entry.modelId)).size;
  const reported = entries.filter((entry) => entry.vramGb != null);
  const sharedGb = reported.length
    ? reported.reduce((total, entry) => total + (entry.vramGb ?? 0), 0)
    : null;
  return (
    <section aria-label="Community mesh">
      <h2 className="text-body">Community mesh</h2>
      {!isTauri() ? (
        <p role="status">Open Buzz desktop to see community mesh.</p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : !inventory ? (
        <p role="status">Loading community mesh…</p>
      ) : inventory.entries.length === 0 ? (
        <p role="status">No one is sharing compute yet.</p>
      ) : (
        <>
          <p className="text-body-sm text-secondary">
            {contributors === 1
              ? "1 person is contributing compute."
              : `${contributors} people are contributing compute.`}
          </p>
          <dl className={styles.metrics}>
            <div>
              <dt className="text-body-sm text-secondary">Shared memory</dt>
              <dd className="m-0 text-body">
                {sharedGb == null
                  ? "Not reported"
                  : `${Math.round(sharedGb)} GB`}
              </dd>
            </div>
            <div>
              <dt className="text-body-sm text-secondary">Models available</dt>
              <dd className="m-0 text-body">{modelCount}</dd>
            </div>
          </dl>
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
                {entry.vramGb != null &&
                  ` — ${entry.vramGb} GB advertised VRAM`}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

import { invoke, isTauri } from "@tauri-apps/api/core";

export type BackupChoice = Readonly<{
  available: boolean;
  pubkey: string;
  automatic: boolean | null;
}>;

export type IdentitySnapshot =
  | { status: "loading" }
  | { status: "missing"; busy: boolean; error?: string }
  | { status: "error"; error: string }
  | { status: "ready"; viewer: string };

// App-owned, not registered on the plugin context. Snapshots contain public data only.
export function createIdentity() {
  let state: IdentitySnapshot = { status: "loading" };
  let disposed = false;
  let busy = false;
  const listeners = new Set<() => void>();
  let resolveReady!: (viewer: string) => void;
  const ready = new Promise<string>((resolve) => {
    resolveReady = resolve;
  });
  const update = (next: IdentitySnapshot) => {
    if (disposed) return;
    state = next;
    if (next.status === "ready") resolveReady(next.viewer);
    for (const listener of listeners) listener();
  };
  async function run(
    command: "identity_restore" | "identity_create" | "identity_import",
    nsec?: string,
  ) {
    if (busy || disposed) return;
    const restoring = command === "identity_restore";
    if (!restoring && state.status !== "missing") return;
    busy = true;
    update(
      restoring ? { status: "loading" } : { status: "missing", busy: true },
    );
    try {
      const viewer = await invoke<string | null>(
        command,
        nsec === undefined ? {} : { nsec },
      );
      if (viewer === null && restoring)
        update({ status: "missing", busy: false });
      else if (typeof viewer === "string" && /^[a-f0-9]{64}$/.test(viewer))
        update({ status: "ready", viewer });
      else
        throw new Error(
          "The saved identity could not be verified. Restart the app.",
        );
    } catch (reason) {
      const error = reason instanceof Error ? reason.message : String(reason);
      update(
        restoring
          ? { status: "error", error }
          : { status: "missing", busy: false, error },
      );
    } finally {
      busy = false;
    }
  }
  void run("identity_restore");
  return {
    ready,
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry: () => run("identity_restore"),
    importKey: (nsec: string) => run("identity_import", nsec),
    create: () => run("identity_create"),
    exportKey: () => invoke<string>("identity_export"),
    /** Public consent only; enabling it wakes the configured native uploader after sign-in. */
    getBackupChoice: () => invoke<BackupChoice>("nsec_backup_choice"),
    /** Pass the key returned by getBackupChoice so a stale selection cannot affect another key. */
    setBackupChoice: (pubkey: string, automatic: boolean) =>
      invoke<BackupChoice>("nsec_backup_set_choice", { pubkey, automatic }),
    /** Why this build can't wipe, if it can't; `sign_out` enforces it either way. */
    wipeRefusal: () => invoke<string | null>("sign_out_wipe_refusal"),
    /** Stops agents and restarts; the key (and data, with wipe) goes on next launch. */
    signOut: (choices: { wipe: boolean; removeAgents: boolean }) =>
      invoke<void>("sign_out", choices),
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
export type Identity = ReturnType<typeof createIdentity>;
export const nativeIdentityEnabled = () =>
  isTauri() &&
  /Mac|Win|Linux/i.test(navigator.platform) &&
  import.meta.env.VITE_BUZZ_LIVE !== "1";

import { invoke, isTauri } from "@tauri-apps/api/core";

/** Serve-node status reported by the native `mesh_*` commands. */
export type MeshStatus = Readonly<{
  running: boolean;
  apiBaseUrl?: string;
  consoleUrl?: string;
  model?: string;
}>;

/**
 * Thin bridge to the native mesh capability. The engine, downloads and process
 * lifecycle all live in Rust (`src-tauri/src/mesh`); this only forwards intent.
 */
export type MeshBridge = {
  available: boolean;
  status(): Promise<MeshStatus>;
  start(model: string): Promise<MeshStatus>;
  stop(): Promise<MeshStatus>;
};

export const nativeBridge: MeshBridge = {
  available: isTauri(),
  status: () => invoke("mesh_status"),
  start: (model) => invoke("mesh_start", { model }),
  stop: () => invoke("mesh_stop"),
};

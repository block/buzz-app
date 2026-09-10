import type { PluginManifest } from "./api";

export type PluginInfo = {
  manifest: PluginManifest;
  source: "bundled" | "external";
  enabled: boolean;
  revision: string;
  previous: string | null;
  error: string | null;
};
export type Catalog = {
  profile: string;
  location: string;
  plugins: PluginInfo[];
};
export type ManagementAction = "enable" | "disable" | "remove" | "rollback";

// Reading configuration either succeeds or provides a recovery path.
// Pausing external code is a launch option, not part of the saved catalog.
export type StorageResult =
  | { status: "ready"; catalog: Catalog; externalPluginsPaused: boolean }
  | { status: "recovery"; reason: string; canReset: boolean };
export type ConfigurationState = { status: "loading" } | StorageResult;

export type ImportPreview = {
  token: string;
  source: string;
  commit: string | null;
  candidates: { path: string; manifest: PluginManifest; revision: string }[];
  warnings: string[];
};
export type PluginImports = {
  folder(): Promise<ImportPreview | null>;
  git(repository: string, reference: string): Promise<ImportPreview | null>;
  install(token: string, path: string): Promise<StorageResult>;
  discard(token: string): Promise<void>;
};

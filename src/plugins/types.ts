import type { PluginManifest } from "./api";

export type PluginInfo = {
  manifest: PluginManifest;
  source: "bundled" | "external";
  enabled: boolean;
  updateChecks?: boolean | null;
  revision: string;
  previous: string | null;
  hasSignature?: boolean;
  publisher?: string | null;
  rollbackBlockedReason?: string | null;
  reloadable: boolean;
  updateSource?:
    | { root: string; path: string }
    | { repository: string; reference: string; path: string; commit?: string }
    | null;
  error: string | null;
  readmeRevision?: string | null;
  iconPngRevision?: string | null;
  iconJpgRevision?: string | null;
};
export type Catalog = {
  profile: string;
  location: string;
  plugins: PluginInfo[];
};
export type ManagementAction =
  | "enable"
  | "disable"
  | "remove"
  | "rollback"
  | "enable-update-checks"
  | "disable-update-checks";

export type ManagedState = "missing" | "current" | "outdated" | "other";
export type ManagedEntry = {
  id: string;
  repository: string;
  reference: string;
  commit: string;
  path: string;
  state: ManagedState;
};
export type ManagedPlugins =
  | { status: "invalid"; path: string; reason: string }
  | {
      status: "ready";
      path: string;
      source: string;
      plugins: ManagedEntry[];
      problems: string[];
    };

// Reading configuration either succeeds or provides a recovery path.
// Pausing external code is a launch option, not part of the saved catalog.
export type StorageResult =
  | {
      status: "ready";
      catalog: Catalog;
      externalPluginsPaused: boolean;
      /** Absent unless the desktop host found a managed plugin policy. */
      managed?: ManagedPlugins;
    }
  | { status: "recovery"; reason: string; canReset: boolean };
export type ConfigurationState = { status: "loading" } | StorageResult;

export type ImportPreview = {
  token: string;
  source: string;
  commit: string | null;
  candidates: {
    path: string;
    manifest: PluginManifest;
    revision: string;
    publisher?: string | null;
    readmeRevision?: string | null;
    iconPngRevision?: string | null;
    iconJpgRevision?: string | null;
  }[];
  warnings: string[];
};
export type ImportFile = { path: string } & (
  | { text: string; base64?: never }
  | { base64: string; text?: never }
);
export type GitScope = {
  commit?: string | undefined;
  path?: string | undefined;
};
export type PluginImports = {
  folder(): Promise<ImportPreview | null>;
  checkFolder(id: string): Promise<string>;
  previewFolder(id: string): Promise<ImportPreview | null>;
  files(source: string, files: ImportFile[]): Promise<ImportPreview | null>;
  /**
   * `authorization` is a NIP-98 token signed for exactly `repository`. `commit`
   * is read directly and refused unless it is on `reference`. `path` lists only
   * that repository folder; candidate paths stay relative to the repository root.
   */
  git(
    repository: string,
    reference: string,
    authorization?: string,
    scope?: GitScope,
  ): Promise<ImportPreview | null>;
  /** Reads Git metadata without acquiring or replacing an installation preview. */
  checkGit(
    repository: string,
    reference: string,
    authorization?: string,
    scope?: GitScope,
  ): Promise<ImportPreview | null>;
  install(token: string, path: string): Promise<StorageResult>;
  discard(token: string): Promise<void>;
};

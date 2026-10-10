import type { Plugin } from "vite";
export type BundledPublicConfig = { builderlabUrl: string };
export function bundledHostPlugin(
  directory?: string,
  publicConfig?: BundledPublicConfig,
): Plugin;

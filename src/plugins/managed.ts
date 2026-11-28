import { parseInstallOnlyRecommendations } from "./managed-config";
import type { ManagedEntry, ManagedPlugins } from "./types";

const installOnlyRecommendations = parseInstallOnlyRecommendations(
  import.meta.env.VITE_BUZZ_INSTALL_ONLY_RECOMMENDATIONS ?? "",
);

function installOnly(source: string, entry: ManagedEntry) {
  // Only advisory defaults opt in. Explicit install/update policies still win.
  return (
    (entry.install === undefined || entry.install === "recommend") &&
    (entry.update === undefined || entry.update === "review") &&
    installOnlyRecommendations.some(
      (selector) => selector.source === source && selector.id === entry.id,
    )
  );
}

/** Whether Settings lists the entry: a "manual" entry only offers updates. */
export function offeredManaged(entry: ManagedEntry, source: string) {
  const { state, install } = entry;
  if (installOnly(source, entry)) return state === "missing";
  return install === "manual" ? state === "outdated" : state !== "current";
}

/** Recommendations that still need the user: not installed, or not at the pinned commit. */
export function pendingManaged(managed: ManagedPlugins | undefined) {
  return managed?.status === "ready"
    ? managed.plugins.filter(
        (entry) =>
          entry.state !== "other" && offeredManaged(entry, managed.source),
      )
    : [];
}

/** The policy governing an installed plugin, including its update controls. */
export function managedBy(
  managed: ManagedPlugins | undefined,
  id: string,
): { source: string; entry: ManagedEntry } | undefined {
  if (managed?.status !== "ready") return undefined;
  const entry = managed.plugins.find(
    (item) =>
      item.id === id &&
      !installOnly(managed.source, item) &&
      (item.state === "current" || item.state === "outdated"),
  );
  return entry && { source: managed.source, entry };
}

/** The Managed by label's source, noting a policy that keeps the plugin current. */
export function managedLabel(managed: ReturnType<typeof managedBy>) {
  return (
    managed &&
    `${managed.source}${managed.entry.update === "automatic" ? " · updates automatically" : ""}`
  );
}

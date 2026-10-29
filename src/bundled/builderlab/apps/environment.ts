// Which Apps Platform a Builderlab sign-in deploys to: the control plane of
// the same tenant, since its session is only valid there. Kept in step with
// `apps_control_plane` in crates/plugin-manager, which grants the plugin that
// origin.
const CONTROL_PLANES: Readonly<Record<string, string>> = {
  "https://app.builderlab.xyz": "https://compose-ctrl.builderlab.xyz",
  "https://app.builderlabstaging.xyz":
    "https://compose-ctrl.builderlabstaging.xyz",
  "https://block.builderlab.xyz": "https://compose-ctrl.block.builderlab.xyz",
};

/** The control plane for the configured Builderlab URL, if it has one. */
export function controlPlane(
  value = import.meta.env.VITE_BUZZ_BUILDERLAB_URL ?? "",
) {
  try {
    return CONTROL_PLANES[new URL(value).origin];
  } catch {
    return undefined;
  }
}

/** DNS labels are 1–63 alphanumeric characters, with interior hyphens allowed. */
const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** App subdomains under apps.[<tenant>.]builderlab[staging].xyz. */
const APP_DOMAINS = new RegExp(
  `^(?:${DNS_LABEL}\\.)+apps\\.(?:${DNS_LABEL}\\.)?builderlab(?:staging)?\\.xyz$`,
);

/** An app's name from its host, `<name>--<workspace>.<apps domain>`. */
export function appName(target: string) {
  try {
    return new URL(target).hostname.split(".")[0]?.split("--")[0] || undefined;
  } catch {
    return undefined;
  }
}

/** Whether `target` is a deployed app's page. */
export function isAppUrl(target: string) {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    APP_DOMAINS.test(host)
  );
}

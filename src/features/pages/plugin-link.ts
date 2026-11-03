import type { OpenTarget } from "../navigation/targets";
import type { ConfigurationState } from "../../plugins/types";
import type { PluginStates } from "../../plugins/runtime";
import type { RegisteredPage } from "./service";

type PluginLink = Extract<OpenTarget, { kind: "plugin" }>;

/** The page a plugin link names: the plugin's primary page, else its first. */
export function linkedPage(
  pages: readonly RegisteredPage[],
  link: PluginLink,
): RegisteredPage | undefined {
  const own = pages.filter((page) => page.pluginId === link.pluginId);
  return link.pageId === undefined
    ? (own.find((page) => page.primary) ?? own[0])
    : own.find((page) => page.id === link.pageId);
}

/** Link data is untrusted text. Only the page's own validator can accept it as
 * route params; without that, the page opens as if no params were given. */
export function linkedPageTarget(
  link: PluginLink,
  page: RegisteredPage,
): OpenTarget {
  let accepted = false;
  try {
    accepted = !!link.params && !!page.route?.validate(link.params);
  } catch {
    accepted = false;
  }
  return {
    version: 1,
    kind: "page",
    pluginId: page.pluginId,
    pageId: page.id,
    ...(link.scope !== undefined ? { scope: link.scope } : {}),
    ...(accepted && page.route && link.params
      ? { route: { version: page.route.version, params: link.params } }
      : {}),
  };
}

export type PluginLinkProblem =
  | { reason: "missing"; name: string; source?: string }
  | { reason: "disabled"; name: string }
  | { reason: "no-page"; name: string; pageId?: string };

/** Why a plugin link found no page, when the plugin itself is the cause. A
 * plugin that is installed and enabled but not running, or whose settings
 * could not be read, keeps the generic failure: nothing here is certain. */
export function pluginLinkProblem(
  link: PluginLink,
  configuration: ConfigurationState,
  activation: PluginStates,
): PluginLinkProblem | undefined {
  if (configuration.status !== "ready") return undefined;
  const installed = configuration.catalog.plugins.find(
    (plugin) => plugin.manifest.id === link.pluginId,
  );
  const state = activation[link.pluginId];
  if (!installed) {
    if (state)
      return { reason: "no-page", name: link.pluginId, ...pageOf(link) };
    const { managed } = configuration;
    const recommendation =
      managed?.status === "ready"
        ? managed.plugins.find(
            (entry) => entry.id === link.pluginId && entry.state === "missing",
          )
        : undefined;
    return {
      reason: "missing",
      name: link.pluginId,
      ...(recommendation && managed?.status === "ready"
        ? { source: managed.source }
        : {}),
    };
  }
  const name = installed.manifest.name;
  if (!installed.enabled) return { reason: "disabled", name };
  if (installed.error || state?.status !== "active") return undefined;
  return { reason: "no-page", name, ...pageOf(link) };
}

const pageOf = (link: PluginLink) =>
  link.pageId === undefined ? {} : { pageId: link.pageId };

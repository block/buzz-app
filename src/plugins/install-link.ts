import {
  parsePluginInstallSource,
  type PluginInstallSource,
} from "./installer";

export type PluginInstallLink = Readonly<{ source: PluginInstallSource }>;

const known = ["repository", "ref", "path", "commit"] as const;

/** `buzz://plugin-install?repository=&ref=[&path=][&commit=]`. A link is a request
 * for review, never authority to install. */
export function parsePluginInstallLink(
  input: string,
): PluginInstallLink | null {
  if (typeof input !== "string" || input.length > 4096) return null;
  if (!/^buzz:\/\/plugin-install\/?\?/.test(input)) return null;
  try {
    const url = new URL(input);
    if (
      url.protocol !== "buzz:" ||
      url.host !== "plugin-install" ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.username ||
      url.password ||
      url.hash
    )
      return null;
    const values: Partial<Record<(typeof known)[number], string>> = {};
    for (const key of known) {
      const all = url.searchParams.getAll(key);
      if (all.length > 1) return null;
      if (all[0] !== undefined) values[key] = all[0];
    }
    const source = parsePluginInstallSource({
      repository: values.repository,
      reference: values.ref,
      ...(values.path === undefined ? {} : { path: values.path }),
      ...(values.commit === undefined ? {} : { commit: values.commit }),
    });
    return source ? { source } : null;
  } catch {
    return null;
  }
}

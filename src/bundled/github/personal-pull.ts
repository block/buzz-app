import type { RelaySession } from "../../features/relay/session";
import { parseGitHubReference } from "./references";

const prefix = "buzz.github.conversation-pull.v1:";
const changed = "buzz-github-conversation-pull-changed";
type Scope = Pick<RelaySession, "scope" | "viewer">;
type Link = Readonly<{ url: string | null; source: "manual" | "announcement" }>;

const keyFor = (scope: Scope, channel: string) => {
  if (!scope.scope || !scope.viewer || !channel)
    throw new Error("A personal pull request needs an identity and community.");
  return `${prefix}${JSON.stringify([scope.scope, scope.viewer, channel])}`;
};

/** Personal, device-local overlay; never a channel artifact or message. */
export function personalPull(scope: Scope, channel: string): Link | undefined {
  const saved = localStorage.getItem(keyFor(scope, channel));
  if (saved === null) return;
  try {
    const link = JSON.parse(saved) as Link;
    if (
      (link.source === "manual" || link.source === "announcement") &&
      (link.url === null ||
        (typeof link.url === "string" &&
          parseGitHubReference(link.url)?.kind === "pull"))
    )
      return link;
  } catch {}
  // A damaged preference must not resurrect a shared link or admit auto-linking.
  return { url: null, source: "manual" };
}

export function watchPersonalPulls(scope: Scope, listener: () => void) {
  const scopePrefix = `${prefix}${JSON.stringify([scope.scope, scope.viewer]).slice(0, -1)},`;
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(scopePrefix)) listener();
  };
  const local = (event: Event) => {
    if ((event as CustomEvent<string>).detail.startsWith(scopePrefix))
      listener();
  };
  window.addEventListener("storage", storage);
  window.addEventListener(changed, local);
  return () => {
    window.removeEventListener("storage", storage);
    window.removeEventListener(changed, local);
  };
}

/** Serialize the check and write across windows as well as agent connections. */
export async function savePersonalPull(
  scope: Scope,
  channel: string,
  url: string | null,
  options: {
    automatic?: boolean;
    signal?: AbortSignal;
    allowed?: () => boolean;
  } = {},
) {
  const key = keyFor(scope, channel);
  if (url !== null && parseGitHubReference(url)?.kind !== "pull")
    throw new Error("url must be a GitHub pull request URL");
  if (!navigator.locks)
    throw new Error(
      "Saving personal pull requests needs browser storage locks.",
    );
  return navigator.locks.request(
    key,
    { ...(options.signal && { signal: options.signal }) },
    () => {
      options.signal?.throwIfAborted();
      if (options.allowed && !options.allowed())
        throw new Error("This conversation's identity or access changed.");
      const current = personalPull(scope, channel);
      if (options.automatic && current)
        return current.source === "announcement" && current.url === url;
      localStorage.setItem(
        key,
        JSON.stringify({
          url,
          source: options.automatic ? "announcement" : "manual",
        }),
      );
      window.dispatchEvent(new CustomEvent(changed, { detail: key }));
      return true;
    },
  );
}

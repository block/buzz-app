// OS-delivered buzz:// links. The native shell holds raw strings; this module is the
// only place that turns them into typed targets, and the ordinary navigation
// admission path alone decides whether a target opens. Browsers have no OS scheme
// handler, so everything here is a no-op outside Tauri.
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { communityDestination } from "../communities/destination";
import type { ClientSnapshot } from "../communities/service";
import { parseBuzzLink } from "./buzz-links";
import type { OpenFailure, OpenResult } from "./controller";
import { bindSharedTarget, parseOpenTarget, type OpenTarget } from "./targets";

export type DeepLinkStep =
  | Readonly<{ open: OpenTarget }>
  | Readonly<{ fail: OpenFailure }>;
/** What the shell exposes: drain held URLs, and learn when more are held. */
export type DeepLinkShell = Readonly<{
  take(): Promise<readonly string[]>;
  watch(listener: () => void): () => void;
}>;
export type DeepLinkHost = Readonly<{
  navigation: Readonly<{ open(target: OpenTarget): Promise<OpenResult> }>;
  /** Host-only: record an ingress that produced no destination. */
  fail(reason: OpenFailure): void;
}>;
type Client = Pick<ClientSnapshot, "status" | "viewer" | "selected">;

/** Decide what one OS URL means for the signed-in client. A bound target still
 * passes the usual viewer, membership and channel checks; nothing here grants access.
 * Legacy `channel`/`message` forms carry no community and bind to the selected one. */
export function deepLinkStep(
  url: string,
  client: Pick<Client, "viewer" | "selected">,
): DeepLinkStep {
  // The shell admits only the exact `buzz` scheme. Agree with it here instead of
  // with URL normalization so the two gates cannot drift apart.
  if (typeof url !== "string" || !url.startsWith("buzz:"))
    return { fail: "invalid-target" };
  const link = parseBuzzLink(url);
  if (!link) return { fail: "invalid-target" };
  try {
    if (link.format === "shared") {
      const target = link.target;
      if (!("scope" in target) || !target.scope)
        return { open: parseOpenTarget(target) };
      if (!client.viewer) return { fail: "unavailable" };
      return { open: bindSharedTarget(target, client.viewer) };
    }
    if (!client.viewer || !client.selected) return { fail: "unavailable" };
    const { format: _format, ...destination } = link;
    return {
      open: parseOpenTarget({
        version: 1,
        kind: "conversation",
        scope: {
          viewer: client.viewer,
          communityOrigin: communityDestination(client.selected).url,
        },
        ...destination,
      }),
    };
  } catch {
    return { fail: "invalid-target" };
  }
}

/** Drain the shell's queue now and on every later arrival, then open each link in
 * arrival order once the client has finished loading. Nothing is auto-joined. */
export function bindDeepLinks(
  host: DeepLinkHost,
  communities: Readonly<{
    snapshot(): Client;
    subscribe(listener: () => void): () => void;
  }>,
  shell = createDeepLinkShell(),
): () => void {
  if (!shell) return () => {};
  let closed = false;
  const held: string[] = [];
  const flush = () => {
    if (closed) return;
    while (held.length) {
      const client = communities.snapshot();
      if (client.status === "loading") return;
      const step = deepLinkStep(held.shift() as string, client);
      if ("open" in step) void host.navigation.open(step.open);
      else host.fail(step.fail);
    }
  };
  // Drains run one at a time so two arrivals cannot reorder each other.
  let draining = Promise.resolve();
  const drain = () => {
    draining = draining.then(async () => {
      let urls: readonly string[];
      try {
        urls = await shell.take();
      } catch (error) {
        if (!closed) console.error("Could not read pending deep links", error);
        return;
      }
      if (closed) return;
      for (const url of urls) if (typeof url === "string") held.push(url);
      flush();
    });
  };
  const stopClient = communities.subscribe(flush);
  // A broken shell bridge must never keep the app from opening.
  let stopShell = () => {};
  try {
    stopShell = shell.watch(drain);
  } catch (error) {
    console.error("Deep link updates are unavailable", error);
  }
  drain();
  return () => {
    if (closed) return;
    closed = true;
    stopClient();
    stopShell();
    held.length = 0;
  };
}

/** The Tauri bridge. It carries raw URL strings from the main window's shell and
 * a queue-depth ping; no destination or account data crosses in either direction. */
export function createDeepLinkShell(): DeepLinkShell | undefined {
  if (!isTauri()) return undefined;
  return {
    async take() {
      const urls = await invoke<unknown>("deep_link_take");
      return Array.isArray(urls)
        ? urls.filter((url): url is string => typeof url === "string")
        : [];
    },
    watch(listener) {
      let active = true;
      const channel = new Channel<unknown>(() => {
        if (active) listener();
      });
      void invoke("deep_link_watch", { onEvent: channel }).catch((error) => {
        if (active) console.error("Deep link updates are unavailable", error);
      });
      return () => {
        active = false;
        channel.onmessage = () => {};
      };
    },
  };
}

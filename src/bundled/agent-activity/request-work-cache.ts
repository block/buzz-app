import type { RelaySession } from "../../features/relay/session";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { ThreadSnapshot } from "../../features/relay/threads";
import { requestWork } from "./request-work";

type Snapshot = ReturnType<RelaySession["agentActivity"]["snapshot"]>;
type Evidence = ThreadSnapshot | readonly ChannelMessage[];
// Pure memoization shared by sibling reply decorations and the inspector. Both
// evidence owners are weak keys: no subscription, capture, or retained history.
const cache = new WeakMap<
  Snapshot,
  WeakMap<Evidence, Map<string, ReturnType<typeof requestWork>>>
>();
export function cachedRequestWork(
  snapshot: Snapshot,
  evidence: Evidence,
  channel: string,
  root: string,
  viewer: string | undefined,
) {
  let threads = cache.get(snapshot);
  if (!threads) {
    threads = new WeakMap();
    cache.set(snapshot, threads);
  }
  let scopes = threads.get(evidence);
  if (!scopes) {
    scopes = new Map();
    threads.set(evidence, scopes);
  }
  const key = JSON.stringify([channel, root, viewer]);
  let result = scopes.get(key);
  if (!result) {
    const rows =
      "replies" in evidence
        ? evidence.root
          ? [evidence.root, ...evidence.replies]
          : evidence.replies
        : evidence;
    result = requestWork(snapshot, rows, channel, root, viewer);
    scopes.set(key, result);
  }
  return result;
}

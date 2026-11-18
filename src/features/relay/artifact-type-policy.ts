import {
  parseTypePolicy,
  typePolicyTemplate,
  type ArtifactTypePolicyAccess,
} from "./artifact-community";
import { PublishNotSent, PublishRejected } from "./outbox";
import type { RelayWriter } from "./transport";

/** The plugin-facing type policy for `community`: `read` fetches the relay's
 * answer, `set` signs and publishes only the kind-9034 command via `writer`. */
export const artifactTypePolicyAccess = (
  community: string,
  read: (type: string, signal: AbortSignal) => Promise<unknown>,
  writer: RelayWriter,
): ArtifactTypePolicyAccess => ({
  async read(type, signal) {
    return parseTypePolicy(await read(type, signal));
  },
  async set(change, signal) {
    const event = await writer.sign(
      typePolicyTemplate(
        community,
        change.type,
        change.policy,
        change.prev,
        Math.floor(Date.now() / 1000),
      ),
      signal,
    );
    try {
      const message = (await writer.publish(event, signal)) ?? "";
      return { id: event.id, ok: true, message };
    } catch (error) {
      signal.throwIfAborted();
      const refused =
        error instanceof PublishRejected && !(error instanceof PublishNotSent);
      return {
        id: event.id,
        ok: false,
        message: refused ? (error.reason ?? error.message) : "",
      };
    }
  },
});

/** Calls a plugin may have running at once through one session. */
const ARTIFACT_TYPE_POLICY_MAX_CALLS = 4;

/** `access` as the session hands it to plugins: frozen, refused once `open()`
 * is false or `ARTIFACT_TYPE_POLICY_MAX_CALLS` calls are running, and each
 * call aborts with `lifetime()`. */
export const sessionTypePolicy = (
  access: ArtifactTypePolicyAccess,
  open: () => boolean,
  lifetime: () => AbortSignal,
): ArtifactTypePolicyAccess => {
  let running = 0;
  const call = async <T>(
    signal: AbortSignal,
    run: (signal: AbortSignal) => Promise<T>,
  ) => {
    if (!open() || running >= ARTIFACT_TYPE_POLICY_MAX_CALLS)
      throw new Error("Artifact type policy unavailable");
    running++;
    try {
      return await run(AbortSignal.any([signal, lifetime()]));
    } finally {
      running--;
    }
  };
  return Object.freeze({
    read: (type, signal) => call(signal, (bound) => access.read(type, bound)),
    set: (change, signal) => call(signal, (bound) => access.set(change, bound)),
  });
};

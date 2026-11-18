import {
  parseTypePolicy,
  typePolicyTemplate,
  type ArtifactTypePolicyAccess,
} from "./artifact-community";
import { PublishNotSent, PublishRejected } from "./outbox";
import type { ReadTransport, RelayWriter } from "./transport";

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

const ARTIFACT_TYPE_POLICY_MAX_CALLS = 4;

/** The session's community fields for plugins, present only with a type
 * policy: `communityId` and a frozen `typePolicy`, refused once `open()` is
 * false or `ARTIFACT_TYPE_POLICY_MAX_CALLS` calls are running. Each call aborts
 * with `lifetime` or `cancel()` (an access change). */
export const sessionTypePolicy = (
  {
    artifactCommunity: communityId,
    artifactTypePolicy: access,
  }: Pick<ReadTransport, "artifactCommunity" | "artifactTypePolicy">,
  open: () => boolean,
  lifetime: AbortSignal,
) => {
  let calls = new AbortController();
  let running = 0;
  const call = async <T>(
    signal: AbortSignal,
    run: (signal: AbortSignal) => Promise<T>,
  ) => {
    if (!open() || running >= ARTIFACT_TYPE_POLICY_MAX_CALLS)
      throw new Error("Artifact type policy unavailable");
    running++;
    try {
      return await run(AbortSignal.any([signal, calls.signal, lifetime]));
    } finally {
      running--;
    }
  };
  return {
    artifacts:
      communityId && access
        ? {
            communityId,
            typePolicy: Object.freeze<ArtifactTypePolicyAccess>({
              read: (type, signal) =>
                call(signal, (bound) => access.read(type, bound)),
              set: (change, signal) =>
                call(signal, (bound) => access.set(change, bound)),
            }),
          }
        : {},
    cancel() {
      calls.abort();
      calls = new AbortController();
    },
  };
};

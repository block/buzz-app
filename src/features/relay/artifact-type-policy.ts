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

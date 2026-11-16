// A task's comments live in its own hidden conversation (NIP-AR), under the
// task's home: who reads and posts there always comes from the home. An
// agent comments as itself, so the relay checks the agent's access.
import type { BuzzClient } from "../../buzz-mcp/client";
import { conversationOpening } from "../../features/relay/artifact-conversation";
import type { Task } from "./model";

/** Posts `text` on `task` as the agent `client` speaks for, opening the
 * conversation if nobody has: a comment is the agent's own words, so the
 * relay checks the agent's access, not its owner's. */
export async function postAgentComment(
  client: Pick<BuzzClient, "publish">,
  task: Task,
  text: string,
): Promise<void> {
  const opening = await conversationOpening(task.id);
  const id = opening.tags[0]?.[1];
  const refused = (reason: unknown) =>
    new Error(
      `You can’t comment on this task: ${
        reason instanceof Error ? reason.message : "the community refused it"
      }`,
    );
  try {
    await client.publish(opening);
    await client.publish({ kind: 9, content: text, tags: [["h", id ?? ""]] });
  } catch (reason) {
    throw refused(reason);
  }
}

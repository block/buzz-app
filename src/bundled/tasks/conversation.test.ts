import { expect, it, vi } from "vitest";
import { artifactConversationId } from "../../features/relay/artifact-conversation";
import { postAgentComment } from "./conversation";
import type { Task } from "./model";

const task = { id: "11111111-1111-4111-8111-111111111111" } as Task;

it("opens the task's conversation and posts there as the agent", async () => {
  const publish = vi.fn(async (event: object) => ({ ...event }) as never);
  await postAgentComment({ publish }, task, "Merged in #12");
  const conversation = await artifactConversationId(task.id);
  expect(publish.mock.calls.map(([event]) => event)).toEqual([
    {
      kind: 9007,
      created_at: expect.any(Number),
      content: "",
      tags: [
        ["h", conversation],
        ["artifact", task.id],
      ],
    },
    { kind: 9, content: "Merged in #12", tags: [["h", conversation]] },
  ]);
});

it("says plainly when the relay refuses the agent", async () => {
  const publish = vi.fn(async () => {
    throw new Error("restricted: not a member");
  });
  await expect(postAgentComment({ publish }, task, "Done")).rejects.toThrow(
    "You can’t comment on this task: restricted: not a member",
  );
  expect(publish).toHaveBeenCalledTimes(1);
});

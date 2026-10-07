import { expect, it } from "vitest";
import { activity } from "../src/activity";
import { createLiveRuns } from "../../../../src/features/agent-types/live";

it("keeps progress without streaming response text and returns only the completed final reply", () => {
  const runs = createLiveRuns((flush) => flush());
  const run = runs.open({
    agent: { id: "a", pubkey: "b", name: "Codex" },
    channelId: "c",
    eventId: "e",
    threadRootId: "e",
  });
  const view = activity(run.live);
  for (const method of ["item/started", "item/completed"]) {
    view.accept({
      method,
      params: { item: { id: "private", type: "reasoning", summary: [] } },
    });
  }
  expect(runs.snapshot()[0]?.steps).toHaveLength(0);
  view.accept({
    method: "item/started",
    params: { item: { id: "r", type: "reasoning" } },
  });
  view.accept({
    method: "item/reasoning/summaryTextDelta",
    params: { itemId: "r", delta: "Completed reasoning summary" },
  });
  view.accept({
    method: "item/completed",
    params: {
      item: {
        id: "r",
        type: "reasoning",
        summary: ["Completed reasoning summary"],
      },
    },
  });
  view.accept({
    method: "item/started",
    params: { item: { id: "m", type: "agentMessage" } },
  });
  view.accept({
    method: "item/agentMessage/delta",
    params: { itemId: "m", delta: "partial answer" },
  });
  expect(view.final()).toBeUndefined();
  expect(runs.snapshot()[0]?.steps[1]?.text).toBe("");
  view.accept({
    method: "item/completed",
    params: {
      item: {
        id: "m",
        type: "agentMessage",
        text: "Complete answer",
        phase: "final_answer",
      },
    },
  });
  expect(view.final()?.text).toBe("Complete answer");
  expect(runs.snapshot()[0]?.steps).toMatchObject([
    { kind: "thinking", text: "Completed reasoning summary", state: "done" },
    { kind: "message", text: "Complete answer", state: "running" },
  ]);
  view.final()?.step.finish({ published: "sent" });
  expect(runs.snapshot()[0]?.steps[1]?.published).toBe("sent");
  view.accept({
    method: "item/started",
    params: {
      item: { id: "cmd", type: "commandExecution", command: "cat result.txt" },
    },
  });
  view.accept({
    method: "item/commandExecution/outputDelta",
    params: { itemId: "cmd", delta: "partial" },
  });
  expect(runs.snapshot()[0]?.steps[2]?.text).toBe("");
  view.accept({
    method: "item/completed",
    params: {
      item: {
        id: "cmd",
        type: "commandExecution",
        aggregatedOutput: "result\n",
        exitCode: 1,
      },
    },
  });
  expect(runs.snapshot()[0]?.steps[2]).toMatchObject({
    text: "cat result.txt\nresult\n",
    state: "error",
    error: "Failed (exit 1)",
  });
  run.close();
});

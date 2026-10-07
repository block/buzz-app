import { expect, it } from "vitest";
import type { AgentDelivery } from "@buzz/author";
import { noLive } from "../../../../src/features/agent-types/live";
import { conversationHistory } from "../src/history";
import { controlCommand, createRunner } from "../src/run";
import type { Connect } from "../src/rpc";

it.each([true, false])(
  "routes a channel turn only after steering is accepted (%s), even if completion precedes the acknowledgement",
  async (accepted) => {
    let startText = "";
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const published: { content: string; tags?: string[][] }[] = [];
    const connect: Connect = async (_id, options) => ({
      close() {},
      async send(text) {
        const m = JSON.parse(text);
        if (m.id == null) return;
        const reply = (result: unknown) =>
          options.onLine(JSON.stringify({ id: m.id, result }));
        switch (m.method) {
          case "config/read":
            reply({ config: {} });
            break;
          case "thread/start":
            reply({ thread: { id: "session" } });
            break;
          case "turn/start":
            startText = m.params.input[0].text;
            reply({ turn: { id: "turn" } });
            started();
            break;
          case "turn/steer":
            options.onLine(
              JSON.stringify({
                method: "item/completed",
                params: {
                  threadId: "session",
                  item: {
                    id: "final",
                    type: "agentMessage",
                    phase: "final_answer",
                    text: "Steered answer",
                  },
                },
              }),
            );
            options.onLine(
              JSON.stringify({
                method: "turn/completed",
                params: {
                  threadId: "session",
                  turn: { id: "turn", status: "completed" },
                },
              }),
            );
            if (accepted) reply({ turnId: "turn" });
            else
              options.onLine(
                JSON.stringify({
                  id: m.id,
                  error: { code: -32600, message: "turn finished" },
                }),
              );
            break;
          default:
            reply({});
        }
      },
    });
    const runner = createRunner(
      connect,
      {
        get: () => undefined,
        set() {},
        delete() {},
      },
      (delivery) =>
        conversationHistory(delivery, async (filters) =>
          filters[0]?.kinds?.includes(9)
            ? [
                {
                  id: "history",
                  pubkey: "teammate",
                  kind: 9,
                  created_at: 0,
                  content: "unmentioned-history",
                  tags: [["h", "engineering"]],
                },
              ]
            : [],
        ),
    );
    const delivery = (root: string, content: string) =>
      ({
        event: {
          id: root,
          pubkey: "owner",
          kind: 9,
          created_at: 1,
          content,
          tags: [["e", root, "", "reply"]],
        },
        channelId: "engineering",
        conversation: { channelName: "engineering" },
        agent: {
          id: "agent",
          pubkey: "bot",
          owner: "owner",
          name: "Codex",
          workspace: { path: "/tmp" },
          publish: async (event: { content: string; tags?: string[][] }) => {
            published.push(event);
            return { id: "published", created_at: 1 };
          },
        },
        config: {},
        signal: new AbortController().signal,
        live: noLive,
        cancelQueued() {},
      }) as unknown as AgentDelivery<unknown>;
    const command = accepted
      ? "🤖 @Codex /steer Change the answer"
      : "/steer Change the answer";
    expect(controlCommand(command, "Codex")).toBe("steer");
    const first = runner(delivery("a".repeat(64), "Start work"), "scope");
    await running;
    const steer = runner(delivery("b".repeat(64), command), "scope");
    await Promise.all([
      first,
      accepted ? steer : expect(steer).rejects.toThrow("turn finished"),
    ]);
    expect(startText).toContain("unmentioned-history");
    expect(startText).toContain("<conversation-context>");
    if (!accepted) {
      expect(published.shift()?.content).toMatch(
        /not accepted.*regular mention/s,
      );
    }
    expect(published).toEqual([
      {
        kind: 9,
        content: "Steered answer",
        tags: [
          ["h", "engineering"],
          ["e", (accepted ? "b" : "a").repeat(64), "", "reply"],
        ],
      },
    ]);
  },
);

// biome-ignore-all lint/style/noNonNullAssertion: Fixtures deliberately require their arranged calls, elements and results to exist.
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apply as applyPlugin } from "./index.ts";
import type { DecisionRequest, Turn } from "./types.ts";
import { message, turn } from "./fake.ts";

afterEach(() => vi.unstubAllGlobals());

// Partial host fixture: only the services this plugin uses are supplied.
const apply = (ctx: {
  react: typeof React;
  agents: {
    registerTurnContext(c: {
      run(turn: Turn): Promise<string | undefined>;
    }): void;
  };
  settingsCards: { register(c: { component: unknown }): void };
  host: Record<string, unknown>;
  effect(execute: () => () => unknown): unknown;
  decisions: {
    status(): string;
    subscribe(listener: () => void): () => void;
    decide(request: DecisionRequest): Promise<import("./types").DecisionResult>;
  };
}) => applyPlugin(ctx as unknown as Parameters<typeof applyPlugin>[0]);

function plugin(status: string) {
  const asked: DecisionRequest[] = [];
  let run: ((turn: Turn) => Promise<string | undefined>) | undefined;
  apply({
    react: React,
    agents: {
      registerTurnContext: (c) => {
        run = c.run;
      },
    },
    settingsCards: { register: () => {} },
    host: {},
    effect: () => {},
    decisions: {
      status: () => status,
      subscribe: () => () => {},
      decide: async (request) => {
        asked.push(request);
        return { outcome: "failed", backend: "x", reason: "timeout" };
      },
    },
  });
  const t = turn(
    { text: "cedar", deadline: Date.now() + 3_000 },
    { events: async () => [message("m", "cedar")] },
  );
  return { recall: () => run!(t), asked };
}

describe("the decisions adapter", () => {
  it.each(["checking", "needs-setup", "unavailable"])(
    "asks nothing while the provider is %s",
    async (status) => {
      const { recall, asked } = plugin(status);
      expect(await recall()).toBeUndefined();
      expect(asked).toHaveLength(0);
    },
  );

  it.each(["ready", "unconfirmed"])(
    "asks a provider that is %s",
    async (status) => {
      const { recall, asked } = plugin(status);
      await recall();
      expect(asked).toHaveLength(1);
    },
  );
});

it("keeps the scoped host receiver and clears semantic work on plugin disposal", async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => JSON.stringify({ embeddingUrl: "http://127.0.0.1:8080" }),
    setItem: vi.fn(),
  });
  let run!: (turn: Turn) => Promise<string | undefined>;
  let dispose!: () => unknown;
  const h = {
    request: vi.fn(async function (
      this: unknown,
      input: import("../../features/host/service").HostRequest,
    ) {
      expect(this).toBe(h);
      const texts: string[] = JSON.parse(input.body ?? "{}").input;
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          model: "m",
          data: texts.map((_, index) => ({ index, embedding: [1, 0] })),
        }),
      };
    }),
  };
  apply({
    react: React,
    host: h,
    agents: {
      registerTurnContext: (c) => {
        run = c.run;
      },
    },
    settingsCards: { register: () => {} },
    effect: (execute) => {
      dispose = execute();
    },
    decisions: {
      status: () => "ready",
      subscribe: () => () => {},
      decide: async () => ({
        outcome: "failed",
        backend: undefined,
        reason: "unavailable",
      }),
    },
  });
  const t = turn(
    { text: "the and of", deadline: Date.now() + 3000 },
    { events: async () => [message("dog", "Labrador")] },
  );
  await run(t);
  await vi.waitFor(() => expect(h.request).toHaveBeenCalledOnce());
  await dispose();
  await run(t);
  expect(h.request).toHaveBeenCalledOnce();
});

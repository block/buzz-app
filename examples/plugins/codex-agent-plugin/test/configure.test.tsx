// @vitest-environment jsdom
import * as React from "react";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { AgentType, Context } from "@buzz/author";
import { apply } from "../src/plugin.ts";
afterEach(cleanup);
it("loads the catalog, saves the selected model and limits thinking to its supported levels", async () => {
  let type!: AgentType;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  apply({
    react: React,
    agentTypes: {
      register(value: AgentType) {
        type = value;
      },
    },
    host: {
      async connectCommand(
        _id: string,
        options: { onLine(text: string): void },
      ) {
        return {
          close() {},
          async send(text: string) {
            const m = JSON.parse(text);
            if (!m.id) return;
            if (m.method === "model/list") await gate;
            options.onLine(
              JSON.stringify({
                id: m.id,
                result:
                  m.method === "model/list"
                    ? {
                        data: [
                          {
                            model: "test-a",
                            displayName: "Model A",
                            isDefault: true,
                            defaultReasoningEffort: "low",
                            supportedReasoningEfforts: [
                              { reasoningEffort: "low", description: "Fast" },
                              {
                                reasoningEffort: "high",
                                description: "Deeper",
                              },
                            ],
                          },
                          {
                            model: "test-b",
                            displayName: "Model B",
                            defaultReasoningEffort: "medium",
                            supportedReasoningEfforts: [
                              {
                                reasoningEffort: "medium",
                                description: "Balanced",
                              },
                            ],
                          },
                        ],
                        nextCursor: null,
                      }
                    : {},
              }),
            );
          },
        };
      },
    },
  } as unknown as Context);
  let saved: unknown;
  function Form() {
    const [config, setConfig] = React.useState(type.defaults);
    saved = config;
    return (
      <type.Configure config={config} disabled={false} onChange={setConfig} />
    );
  }
  render(<Form />);
  try {
    expect((screen.getByLabelText("Model") as HTMLSelectElement).disabled).toBe(
      true,
    );
  } finally {
    release();
  }
  await screen.findByText("2 models available");
  fireEvent.change(screen.getByLabelText("Thinking"), {
    target: { value: "high" },
  });
  expect(saved).toMatchObject({ effort: "high" });
  fireEvent.change(screen.getByLabelText("Model"), {
    target: { value: "test-b" },
  });
  await waitFor(() =>
    expect(saved).toMatchObject({ model: "test-b", effort: "medium" }),
  );
  expect(screen.queryByRole("option", { name: "High" })).toBeNull();
  expect(screen.getByText("Balanced")).toBeTruthy();
});

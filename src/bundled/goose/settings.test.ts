import { expect, it } from "vitest";
import { settingsProblem } from "../../features/agents/agent-config";
import {
  syncedSettings as claude,
  syncedSettingsSchema as claudeSchema,
} from "../claude-code/settings";
import {
  syncedSettings as codex,
  syncedSettingsSchema as codexSchema,
} from "../codex/settings";
import { DEFAULT_CONFIG as gooseDefaults } from "./runtime";
import {
  syncedSettings as goose,
  syncedSettingsSchema as gooseSchema,
  withSyncedSettings,
} from "./settings";

it("syncs every agent setting except instructions, for each local agent type", () => {
  const base = {
    model: "m",
    effort: "high",
    instructions: "secret plan",
    workspace: "~/w",
    scope: "thread" as const,
  };
  expect(claude(base)).toEqual({
    model: "m",
    effort: "high",
    workspace: "~/w",
    scope: "thread",
  });
  expect(codex(base)).toEqual({
    model: "m",
    effort: "high",
    workspace: "~/w",
    scope: "thread",
  });
  expect(goose({ ...gooseDefaults, provider: "p", instructions: "x" })).toEqual(
    {
      model: "",
      provider: "p",
      workspace: "~/.buzz",
      scope: "thread",
    },
  );
  for (const [schema, settings] of [
    [claudeSchema, claude(base)],
    [codexSchema, codex(base)],
    [gooseSchema, goose(gooseDefaults)],
  ] as const)
    expect(settingsProblem(schema, settings)).toBeUndefined();
});

it("applies only allowlisted synced fields over local config", () => {
  const local = { ...gooseDefaults, instructions: "mine" };
  expect(
    withSyncedSettings(local, {
      model: "m2",
      instructions: "theirs",
      workspace: "/srv",
    }),
  ).toEqual({ ...local, model: "m2", workspace: "/srv" });
});

import { expect, it } from "vitest";
import { modelChoice } from "./models";

it.each([
  ["Sol 6", "OpenAI"],
  ["Sol 6.1", "OpenAI"],
  ["Luna 6", "OpenAI"],
  ["Astra 6", "OpenAI"],
  ["Sonnet 5.5", "Claude"],
  ["Opus 5.5", "Claude"],
  ["Grok 4.7", "Grok"],
  ["GLM 5.3", "GLM"],
  ["GLM 5.3 Flash", "GLM"],
  ["Kimi K3", "Kimi"],
  ["DeepSeek 4.1 Flash", "DeepSeek"],
  ["Future Model", "Other"],
  ["Solstice", "Other"],
  ["constructor", "Other"],
])(
  "maps the Builderlab catalog alias %s to %s without rewriting its identity",
  (displayName, family) => {
    expect(
      modelChoice({
        id: "opaque-provider-id",
        displayName,
        supportedReasoningEfforts: ["high"],
      }),
    ).toEqual({
      id: "opaque-provider-id",
      label: displayName,
      family,
    });
  },
);

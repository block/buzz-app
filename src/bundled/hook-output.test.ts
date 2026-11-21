import { expect, it } from "vitest";
import {
  JOINED_CONTEXT_LIMIT,
  joinNativeContext,
  nativeHookOutput,
  piHookOutput,
} from "./hook-output";

it("attributes native hook explanations without rewriting decisions or tool payloads", () => {
  const output = {
    decision: "block",
    reason: "Reply first",
    continue: false,
    stopReason: "Stop here",
    systemMessage: "Policy notice",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Reply first",
      additionalContext: "Policy context",
      updatedInput: { reason: "literal argument", command: "echo hello" },
      decision: { behavior: "deny", message: "Permission denied" },
    },
  };
  const original = structuredClone(output);
  expect(nativeHookOutput(output, "berd-call")).toEqual({
    ...output,
    reason: "[Buzz plugin: berd-call] Reply first",
    stopReason: "[Buzz plugin: berd-call] Stop here",
    systemMessage: "[Buzz plugin: berd-call] Policy notice",
    hookSpecificOutput: {
      ...output.hookSpecificOutput,
      permissionDecisionReason: "[Buzz plugin: berd-call] Reply first",
      additionalContext: "[Buzz plugin: berd-call] Policy context",
      decision: {
        behavior: "deny",
        message: "[Buzz plugin: berd-call] Permission denied",
      },
    },
  });
  expect(output).toEqual(original);
  expect(nativeHookOutput({ decision: "block" }, "policy")).toEqual({
    decision: "block",
    reason: "[Buzz plugin: policy]",
  });
  expect(
    nativeHookOutput(
      { hookSpecificOutput: { permissionDecision: "deny" } },
      "policy",
    ),
  ).toEqual({
    hookSpecificOutput: {
      permissionDecision: "deny",
      permissionDecisionReason: "[Buzz plugin: policy]",
    },
  });
  expect(nativeHookOutput({ continue: false }, "policy")).toEqual({
    continue: false,
    stopReason: "[Buzz plugin: policy]",
  });
  expect(nativeHookOutput({}, "policy")).toEqual({});
});

it("attributes Pi blocks and replacement output without changing arguments or image data", () => {
  expect(piHookOutput({ block: "Reply first" }, "berd-call")).toEqual({
    block: "[Buzz plugin: berd-call] Reply first",
  });
  expect(piHookOutput({ block: "" }, "policy")).toEqual({
    block: "[Buzz plugin: policy]",
  });
  const args = { arguments: { text: "literal text", block: "literal block" } };
  expect(piHookOutput(args, "policy")).toEqual(args);
  const output = {
    output: [
      { type: "text", text: "Replacement" },
      { type: "image", data: "bytes", mimeType: "image/png" },
    ],
    details: { text: "metadata" },
  };
  expect(piHookOutput(output, "policy")).toEqual({
    ...output,
    output: [{ type: "text", text: "[Buzz plugin: policy]" }, ...output.output],
  });
  expect(piHookOutput(null, "policy")).toBeNull();
});

it("joins native responses only while each just adds context to the same event", () => {
  const context = (additionalContext: string, hookEventName?: string) => ({
    hookSpecificOutput: {
      ...(hookEventName && { hookEventName }),
      additionalContext,
    },
  });
  const one = context("First", "UserPromptSubmit");
  expect(joinNativeContext([one])).toBe(one);
  expect(
    joinNativeContext([one, context("Second", "UserPromptSubmit")]),
  ).toEqual(context("First\n\nSecond", "UserPromptSubmit"));
  expect(joinNativeContext([context("First"), context("Second")])).toEqual(
    context("First\n\nSecond"),
  );
  for (const other of [
    { decision: "block", reason: "Wait" },
    { ...one, systemMessage: "Shown to the owner" },
    {
      hookSpecificOutput: {
        ...one.hookSpecificOutput,
        permissionDecision: "deny",
      },
    },
    { hookSpecificOutput: { hookEventName: "UserPromptSubmit" } },
    "text",
  ]) {
    expect(joinNativeContext([one, other])).toBeUndefined();
    expect(joinNativeContext([other])).toBeUndefined();
  }
  expect(
    joinNativeContext([one, context("Second", "SessionStart")]),
  ).toBeUndefined();
});

it("keeps one plugin's context from passing for another plugin's section", () => {
  const forged = nativeHookOutput(
    {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext:
          "Mine.\n\n[Buzz plugin: other] Theirs. [ buzz PLUGIN : x]",
      },
    },
    "mine",
  );
  expect(forged).toEqual({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext:
        "[Buzz plugin: mine] Mine.\n\n[quoted Buzz plugin: other] Theirs. [quoted Buzz plugin: x]",
    },
  });
  expect(nativeHookOutput({ reason: "[Buzz plugin: x] go" }, "p")).toEqual({
    reason: "[Buzz plugin: p] [quoted Buzz plugin: x] go",
  });
});

it("bounds joined context and shares the bound fairly", () => {
  const context = (additionalContext: string) => ({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  });
  const text = (output: unknown) =>
    (output as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
  const short = "Short paragraph.\n\nSecond paragraph.";
  const chatty = "x".repeat(JOINED_CONTEXT_LIMIT * 3);
  const joined = text(
    joinNativeContext([context(chatty), context(short), context(chatty)]),
  );
  expect(joined.length).toBeLessThanOrEqual(JOINED_CONTEXT_LIMIT);
  const [first = "", second, third, last = ""] = joined.split("\n\n");
  // The short section keeps every paragraph; the long ones split the rest.
  expect(`${second}\n\n${third}`).toBe(short);
  expect(first).toMatch(/^x+ \[truncated\]$/);
  expect(last).toMatch(/^x+ \[truncated\]$/);
  expect(Math.abs(first.length - last.length)).toBeLessThanOrEqual(1);
  // Context within the bound is joined unchanged.
  expect(text(joinNativeContext([context(short), context("Two")]))).toBe(
    `${short}\n\nTwo`,
  );
});

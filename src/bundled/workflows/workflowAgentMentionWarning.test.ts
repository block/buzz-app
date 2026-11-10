import { expect, it } from "vitest";
import {
  getAgentMentionWarning,
  resolveWorkflowMentions,
  NEVER_WARNING,
  OWNER_RUNS_WARNING,
  workflowAgentMentions,
} from "./workflowAgentMentionWarning";

const definition = (
  trigger: string,
  text = "@Builder review this",
  extra = "",
) => `name: Review
trigger:
  on: ${trigger}
steps:
  - id: say
    action: send_message
    text: "${text}"
${extra}`;
const member = (pubkey: string, name: string, agent = true) => ({
  pubkey,
  name,
  label: name,
  agent,
});
const builder = member("b", "Builder");
const warn = (
  yaml: string,
  mode = workflowAgentMentions({ workflow_agent_mentions: "owner" }),
  members = [builder],
) => getAgentMentionWarning(yaml, members, mode);

it.each(["message_posted", "reaction_added", "diff_posted"])(
  "warns that only your own runs direct agents on a %s trigger",
  (trigger) => expect(warn(definition(trigger))).toBe(OWNER_RUNS_WARNING),
);

it("warns that agents never act on a webhook trigger", () => {
  expect(warn(definition("webhook"))).toBe(NEVER_WARNING);
});

it("warns that agents never act with any step but a message or delay", () => {
  const webhook = `  - id: fetch
    action: call_webhook
    url: https://example.test
`;
  expect(warn(definition("schedule", undefined, webhook))).toBe(NEVER_WARNING);
  expect(warn(definition("message_posted", undefined, webhook))).toBe(
    NEVER_WARNING,
  );
});

it("doesn't warn a schedule with only message and delay steps", () => {
  const delay = `  - id: wait
    action: delay
    duration: 5m
`;
  expect(warn(definition("schedule", undefined, delay))).toBeNull();
});

it("doesn't warn without an agent mention", () => {
  expect(warn(definition("webhook", "@Someone else"))).toBeNull();
  expect(getAgentMentionWarning(definition("webhook"), [], "owner")).toBeNull();
});

it("doesn't warn on a relay that lets any run direct agents, or an older one", () => {
  expect(warn(definition("webhook"), workflowAgentMentions({}))).toBeNull();
  expect(
    warn(
      definition("webhook"),
      workflowAgentMentions({ workflow_agent_mentions: "any" }),
    ),
  ).toBeNull();
  expect(workflowAgentMentions({ workflow_agent_mentions: "OWNER" })).toBe(
    "any",
  );
});

it.each([
  ["@builder review this", true],
  ["@BUILDER, review this", true],
  ["(@Builder) review", true],
  ["@BuilderExtra review", false],
  ["mail@Builder review", false],
  ["@Builder_2 review", false],
])("matches %s as the relay does", (text, warns) => {
  expect(warn(definition("webhook", text)) !== null).toBe(warns);
});

it("matches the longest name first, then checks it is an agent", () => {
  const person = member("p", "Builder Bob", false);
  expect(
    warn(definition("webhook", "@Builder Bob review"), undefined, [
      builder,
      person,
    ]),
  ).toBeNull();
  expect(
    resolveWorkflowMentions("@Builder Bob and @Builder", [builder, person]),
  ).toEqual([person, builder]);
});

it("names no one for a name two members share", () => {
  const twin = member("t", "builder", false);
  expect(warn(definition("webhook"), undefined, [builder, twin])).toBeNull();
  expect(
    resolveWorkflowMentions("@Builder", [builder, { ...builder }]),
  ).toEqual([builder]);
});

it("folds case per code point, so later mentions keep their place", () => {
  const dotted = member("i", "İ", false);
  expect(resolveWorkflowMentions("@İ @Builder", [dotted, builder])).toEqual([
    dotted,
    builder,
  ]);
});

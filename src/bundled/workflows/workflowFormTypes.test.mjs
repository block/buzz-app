import assert from "node:assert/strict";
import { test } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  formStateToYaml,
  yamlToFormState,
  DEFAULT_FORM_STATE,
} from "./workflowFormTypes.ts";

function accepted(yaml) {
  const result = yamlToFormState(yaml);
  assert.equal(result.ok, true, result.ok ? undefined : result.error);
  return result.state;
}

function normalizeBackendDefaults(value) {
  const copy = structuredClone(value);
  if (copy.enabled === undefined) copy.enabled = true;
  return copy;
}

function sendMessageState(overrides) {
  return {
    ...DEFAULT_FORM_STATE,
    name: "Auto Reply",
    trigger: { on: "message_posted", filter: "trigger_is_reply == false" },
    steps: [
      {
        id: "step_1",
        action: "send_message",
        text: "pre-written reply",
        ...overrides,
      },
    ],
  };
}

const acceptedFixtures = [
  `name: Notify\ntrigger: { on: message_posted }\nsteps: [{ id: notify_1, action: send_message, text: hello }]\n`,
  `name: React\ndescription: Reply to a reaction\nenabled: false\ntrigger: { on: reaction_added, emoji: eyes, filter: 'trigger_message_id == "abc123"' }\nsteps: [{ id: reply, name: Reply, timeout_secs: 30, action: send_message, text: hi, channel: channel-id, reply_in_thread: true }, { id: wait, action: delay, duration: 5m }]\n`,
];

test("accepted Form fixtures survive a semantic YAML round trip", () => {
  for (const fixture of acceptedFixtures) {
    const generated = formStateToYaml(accepted(fixture));
    assert.deepEqual(
      normalizeBackendDefaults(parseYaml(generated)),
      normalizeBackendDefaults(parseYaml(fixture)),
    );
  }
});

test("recognized nodes with unknown fields are refused without touching YAML", () => {
  const fixtures = [
    `name: Test\nunknown: true\ntrigger: { on: message_posted }\nsteps: [{ id: s1, action: send_message, text: hi }]\n`,
    `name: Test\ntrigger: { on: message_posted, future_filter: x }\nsteps: [{ id: s1, action: send_message, text: hi }]\n`,
    `name: Test\ntrigger: { on: message_posted }\nsteps: [{ id: s1, action: send_message, text: hi, retry: 3 }]\n`,
    `name: Test\ntrigger: { on: message_posted }\nsteps: [{ id: s1, action: call_webhook, url: https://example.com, auth: bearer }]\n`,
  ];

  for (const yaml of fixtures) {
    const original = yaml;
    const result = yamlToFormState(yaml);
    assert.equal(result.ok, false);
    assert.match(result.error, /YAML editor/);
    assert.equal(yaml, original);
  }
});

test("invalid IDs, shapes, and scalar types are refused", () => {
  const cases = [
    [
      "missing ID",
      `name: Test\ntrigger: { on: message_posted }\nsteps: [{ action: send_message, text: hi }]\n`,
    ],
    [
      "duplicate ID",
      `name: Test\ntrigger: { on: message_posted }\nsteps: [{ id: same, action: send_message, text: hi }, { id: same, action: delay, duration: 5m }]\n`,
    ],
    [
      "invalid ID",
      `name: Test\ntrigger: { on: message_posted }\nsteps: [{ id: bad-id, action: send_message, text: hi }]\n`,
    ],
    [
      "oversize ID",
      `name: Test\ntrigger: { on: message_posted }\nsteps: [{ id: ${"a".repeat(65)}, action: send_message, text: hi }]\n`,
    ],
    [
      "steps object",
      `name: Test\ntrigger: { on: message_posted }\nsteps: { id: s1, action: send_message, text: hi }\n`,
    ],
    [
      "missing required action field",
      `name: Test\ntrigger: { on: message_posted }\nsteps: [{ id: s1, action: send_message }]\n`,
    ],
    [
      "numeric text",
      `name: Test\ntrigger: { on: message_posted }\nsteps: [{ id: s1, action: send_message, text: 42 }]\n`,
    ],
    [
      "numeric header",
      `name: Test\ntrigger: { on: message_posted }\nsteps: [{ id: s1, action: call_webhook, url: https://example.com, headers: { X-Retry: 3 } }]\n`,
    ],
    [
      "zero timeout",
      `name: Test\ntrigger: { on: message_posted }\nsteps: [{ id: s1, timeout_secs: 0, action: send_message, text: hi }]\n`,
    ],
    [
      "fractional timeout",
      `name: Test\ntrigger: { on: message_posted }\nsteps: [{ id: s1, timeout_secs: 1.5, action: send_message, text: hi }]\n`,
    ],
    [
      "unsupported method",
      `name: Test\ntrigger: { on: message_posted }\nsteps: [{ id: s1, action: call_webhook, url: https://example.com, method: OPTIONS }]\n`,
    ],
  ];

  for (const [name, yaml] of cases) {
    assert.equal(yamlToFormState(yaml).ok, false, name);
  }
});

test("step condition capabilities stay in YAML mode", () => {
  const condition = `name: Conditional\ntrigger: { on: message_posted }\nsteps: [{ id: s1, if: trigger_author == "abc", action: send_message, text: hi }]\n`;

  const conditionResult = yamlToFormState(condition);
  assert.equal(conditionResult.ok, false);
  assert.match(conditionResult.error, /conditions.*YAML editor/);
});

test("malformed and unowned schedule definitions stay losslessly in YAML mode", () => {
  const fixtures = [
    `name: Missing\ntrigger: { on: schedule }\nsteps: [{ id: s1, action: send_message, text: hi }]\n`,
    `name: Both\ntrigger: { on: schedule, cron: "0 9 * * *", interval: 1h }\nsteps: [{ id: s1, action: send_message, text: hi }]\n`,
    `name: Numeric\ntrigger: { on: schedule, interval: 30 }\nsteps: [{ id: s1, action: send_message, text: hi }]\n`,
    `name: Unknown\ntrigger: { on: schedule, cron: "0 9 * * *", timezone: UTC }\nsteps: [{ id: s1, action: send_message, text: hi }]\n`,
    `name: Invalid cron\ntrigger: { on: schedule, cron: "60 9 * * *" }\nsteps: [{ id: s1, action: send_message, text: hi }]\n`,
  ];

  for (const yaml of fixtures) {
    const original = yaml;
    const result = yamlToFormState(yaml);
    assert.equal(result.ok, false);
    assert.match(result.error, /YAML editor/);
    assert.equal(yaml, original);
  }
});

test("presents step timeout seconds as durations and serializes them numerically", () => {
  const yaml = `name: Timed\ntrigger: { on: message_posted }\nsteps: [{ id: s1, timeout_secs: 3602, action: send_message, text: hi }]\n`;
  const state = accepted(yaml);

  assert.equal(state.steps[0].timeoutSecs, "1h 2s");
  state.steps[0].timeoutSecs = "5m";
  assert.equal(parseYaml(formStateToYaml(state)).steps[0].timeout_secs, 300);
});

test("advanced message expressions survive unrelated Form serialization", () => {
  const filter =
    'str_contains(trigger_text, "deploy") && trigger_author == "abc"';
  const yaml = `name: Advanced\ndescription: Before\ntrigger:\n  on: message_posted\n  filter: '${filter}'\nsteps:\n  - id: s1\n    action: send_message\n    text: hi\n`;
  const state = accepted(yaml);
  state.description = "After";
  const generated = parseYaml(formStateToYaml(state));

  assert.equal(generated.description, "After");
  assert.equal(generated.trigger.filter, filter);
});

test("values the Form serializer would normalize are refused", () => {
  const fixtures = [
    `name: Test\ndescription: " spaced "\ntrigger: { on: message_posted }\nsteps: [{ id: s1, action: send_message, text: hi }]\n`,
    `name: Test\ndescription: ""\ntrigger: { on: message_posted }\nsteps: [{ id: s1, action: send_message, text: hi }]\n`,
    `name: Test\ntrigger: { on: reaction_added, emoji: "" }\nsteps: [{ id: s1, action: send_message, text: hi }]\n`,
    `name: Test\ntrigger: { on: message_posted }\nsteps: [{ id: s1, name: " spaced ", action: send_message, text: hi }]\n`,
    `name: Test\ntrigger: { on: message_posted }\nsteps: [{ id: s1, action: send_message, text: hi, channel: "" }]\n`,
    `name: Test\ntrigger: { on: message_posted }\nsteps: [{ id: s1, action: call_webhook, url: https://example.com, headers: { " padded ": value } }]\n`,
  ];

  for (const yaml of fixtures) assert.equal(yamlToFormState(yaml).ok, false);
});

test("reply_in_thread is emitted only when the checkbox is on", () => {
  const withReply = formStateToYaml(sendMessageState({ replyInThread: true }));
  assert.match(withReply, /reply_in_thread: true/);

  const withoutReply = formStateToYaml(
    sendMessageState({ replyInThread: false }),
  );
  assert.doesNotMatch(withoutReply, /reply_in_thread/);

  const unset = formStateToYaml(sendMessageState({}));
  assert.doesNotMatch(unset, /reply_in_thread/);
});

test("invalid reply_in_thread values are refused rather than normalized", () => {
  const original = (yaml) => {
    const result = yamlToFormState(yaml);
    assert.equal(result.ok, false);
    assert.match(result.error, /YAML editor/);
    return result;
  };

  // Non-boolean would be silently deleted on serialization.
  const nonBoolean = `name: Coerced\ntrigger: { on: message_posted }\nsteps: [{ id: s1, action: send_message, text: hi, reply_in_thread: "yes" }]\n`;
  assert.match(original(nonBoolean).error, /reply_in_thread must be a boolean/);
});

test("reply_in_thread round-trips YAML -> form -> YAML", () => {
  const yaml = formStateToYaml(sendMessageState({ replyInThread: true }));
  const parsed = yamlToFormState(yaml);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.state.steps[0].replyInThread, true);

  const reserialized = formStateToYaml(parsed.state);
  assert.match(reserialized, /reply_in_thread: true/);
});

test("absent reply_in_thread parses as false", () => {
  const yaml = [
    "name: No Reply",
    "trigger:",
    "  on: message_posted",
    "steps:",
    "  - id: step_1",
    "    action: send_message",
    "    text: hi",
    "",
  ].join("\n");
  const parsed = yamlToFormState(yaml);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.state.steps[0].replyInThread, false);
});

test("new workflow drafts start explicitly disabled", () => {
  assert.equal(DEFAULT_FORM_STATE.enabled, false);
  assert.equal(parseYaml(formStateToYaml(DEFAULT_FORM_STATE)).enabled, false);
});

test("unsupported legacy triggers and actions remain YAML-only without parsing into form state", () => {
  for (const trigger of ["diff_posted", "webhook", "schedule"]) {
    const yaml = `# retained\nname: Advanced\ntrigger: { on: ${trigger}, cron: '0 9 * * *' }\nsteps: [{id: s1, action: send_message, text: hi}]\n`;
    const result = yamlToFormState(yaml);
    assert.equal(result.ok, false);
    assert.match(result.error, /Unsupported trigger.*YAML editor/);
    assert.match(yaml, /# retained/);
  }
  for (const action of [
    "send_dm",
    "call_webhook",
    "request_approval",
    "add_reaction",
    "set_channel_topic",
  ]) {
    const result = yamlToFormState(
      `name: Advanced\ntrigger: {on: message_posted}\nsteps: [{id: s1, action: ${action}}]\n`,
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /Unsupported action.*YAML editor/);
  }
});

import assert from "node:assert/strict";
import { test } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  formStateToYaml,
  isThreadReplyEligibleTrigger,
  nextStepId,
  withTriggerType,
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
  `name: Diff\ntrigger: { on: diff_posted }\nsteps: [{ id: s1, action: send_message, text: hi }]\n`,
  `name: Diff review\ntrigger: { on: diff_posted, filter: 'str_contains(trigger_text, "src/")' }\nsteps: [{ id: s1, action: send_message, text: reviewing, reply_in_thread: true }, { id: wait, action: delay, duration: 1m }]\n`,
  `name: Standup\ntrigger: { on: schedule, cron: '0 9 * * 1-5' }\nsteps: [{ id: prompt, action: send_message, text: Standup time }]\n`,
  `name: Tick\nenabled: false\ntrigger: { on: schedule, interval: 30m }\nsteps: [{ id: s1, action: send_message, text: tick }, { id: wait, action: delay, duration: 1m }]\n`,
  `name: Aliases\ntrigger: { on: schedule, cron: '0 */2 1,15 JAN,MAR MON-FRI' }\nsteps: [{ id: s1, action: send_message, text: hi }]\n`,
  `name: Hook\ntrigger: { on: webhook }\nsteps: [{ id: s1, action: send_message, text: hi }, { id: wait, action: delay, duration: 2s }]\n`,
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
    `name: Test\ntrigger: { on: diff_posted, cron: '0 9 * * *' }\nsteps: [{ id: s1, action: send_message, text: hi }]\n`,
    `name: Test\ntrigger: { on: schedule, cron: '0 9 * * *', filter: 'true' }\nsteps: [{ id: s1, action: send_message, text: hi }]\n`,
    `name: Test\ntrigger: { on: schedule, cron: '0 9 * * *', emoji: eyes }\nsteps: [{ id: s1, action: send_message, text: hi }]\n`,
  ];

  for (const yaml of fixtures) {
    const original = yaml;
    const result = yamlToFormState(yaml);
    assert.equal(result.ok, false);
    assert.match(result.error, /YAML editor/);
    assert.equal(yaml, original);
  }
});

test("diff_posted accepts only a filter and never emits emoji", () => {
  const withEmoji = yamlToFormState(
    `name: Test\ntrigger: { on: diff_posted, emoji: eyes }\nsteps: [{ id: s1, action: send_message, text: hi }]\n`,
  );
  assert.equal(withEmoji.ok, false);
  assert.match(
    withEmoji.error,
    /Unsupported diff_posted trigger field "emoji" — use the YAML editor/,
  );

  const generated = parseYaml(
    formStateToYaml({
      ...DEFAULT_FORM_STATE,
      name: "Diff",
      trigger: {
        on: "diff_posted",
        emoji: "eyes",
        filter: 'trigger_text != ""',
      },
      steps: [{ id: "s1", action: "send_message", text: "hi" }],
    }),
  );
  assert.deepEqual(generated.trigger, {
    on: "diff_posted",
    filter: 'trigger_text != ""',
  });
});

test("reply_in_thread is accepted on every message-bearing trigger", () => {
  for (const trigger of ["message_posted", "reaction_added", "diff_posted"]) {
    assert.equal(isThreadReplyEligibleTrigger(trigger), true);
    const yaml = `name: Reply\ntrigger: { on: ${trigger} }\nsteps: [{ id: s1, action: send_message, text: hi, reply_in_thread: true }]\n`;
    const state = accepted(yaml);
    assert.equal(state.trigger.on, trigger);
    assert.equal(state.steps[0].replyInThread, true);
    assert.match(formStateToYaml(state), /reply_in_thread: true/);
  }
});

test("reply_in_thread on a schedule trigger is refused with the reference message", () => {
  assert.equal(isThreadReplyEligibleTrigger("schedule"), false);
  const result = yamlToFormState(
    `name: Bad\ntrigger: { on: schedule, cron: '0 9 * * 1-5' }\nsteps: [{ id: s1, action: send_message, text: hi, reply_in_thread: true }]\n`,
  );
  assert.equal(result.ok, false);
  assert.equal(
    result.error,
    "reply_in_thread is not supported for schedule triggers — use the YAML editor",
  );
  // The relay accepts an explicit false anywhere, and so does Form mode.
  const explicitFalse = accepted(
    `name: OK\ntrigger: { on: schedule, cron: '0 9 * * 1-5' }\nsteps: [{ id: s1, action: send_message, text: hi, reply_in_thread: false }]\n`,
  );
  assert.equal(explicitFalse.steps[0].replyInThread, false);
});

test("schedule triggers need exactly one of cron or interval, with reference messages", () => {
  const refused = (trigger) => {
    const result = yamlToFormState(
      `name: Test\ntrigger: ${trigger}\nsteps: [{ id: s1, action: send_message, text: hi }]\n`,
    );
    assert.equal(result.ok, false, trigger);
    return result.error;
  };
  assert.equal(
    refused("{ on: schedule, cron: '0 9 * * *', interval: 30m }"),
    "Schedule triggers cannot specify both cron and interval — use the YAML editor",
  );
  assert.equal(
    refused("{ on: schedule }"),
    "Schedule triggers require either cron or interval — use the YAML editor",
  );
  assert.equal(
    refused("{ on: schedule, cron: not-a-cron }"),
    "Unsupported cron expression: Paste a 5-field cron expression. Found 1 field. Use the YAML editor",
  );
  assert.equal(
    refused("{ on: schedule, cron: '0 9 * * 8' }"),
    "Unsupported cron expression: Weekday must be between 1 and 7. Use the YAML editor",
  );
  // The relay accepts 6- and 7-field cron; Form mode leaves those to YAML.
  assert.equal(
    refused("{ on: schedule, cron: '0 0 9 * * 1-5' }"),
    "Unsupported cron expression: Paste a 5-field cron expression. Found 6 fields. Use the YAML editor",
  );
  assert.equal(
    refused("{ on: schedule, cron: '' }"),
    "trigger.cron cannot be empty in Form mode — use the YAML editor",
  );
  assert.equal(
    refused("{ on: schedule, interval: 30 }"),
    "trigger.interval must be a string — use the YAML editor",
  );
  assert.equal(
    refused("{ on: schedule, interval: '' }"),
    "trigger.interval cannot be empty in Form mode — use the YAML editor",
  );
  // Non-schedule type errors keep their original wording.
  assert.equal(
    yamlToFormState(
      `name: Test\ntrigger: { on: message_posted, filter: 42 }\nsteps: [{ id: s1, action: send_message, text: hi }]\n`,
    ).error,
    "trigger.filter must be a string",
  );
});

test("the serializer emits exactly one schedule representation and no message fields", () => {
  const schedule = (trigger) =>
    parseYaml(
      formStateToYaml({
        ...DEFAULT_FORM_STATE,
        name: "Scheduled",
        trigger,
        steps: [{ id: "s1", action: "send_message", text: "hi" }],
      }),
    ).trigger;

  assert.deepEqual(
    schedule({ on: "schedule", cron: "0 9 * * *", interval: "15m" }),
    { on: "schedule", cron: "0 9 * * *" },
  );
  assert.deepEqual(schedule({ on: "schedule", interval: "15m" }), {
    on: "schedule",
    interval: "15m",
  });
  assert.deepEqual(schedule({ on: "schedule", cron: "", interval: "1h" }), {
    on: "schedule",
    interval: "1h",
  });
  assert.deepEqual(
    schedule({
      on: "schedule",
      cron: "0 9 * * *",
      filter: "true",
      emoji: "eyes",
    }),
    { on: "schedule", cron: "0 9 * * *" },
  );
  // Cron and interval never leak onto message triggers either.
  assert.deepEqual(
    schedule({ on: "message_posted", cron: "0 9 * * *", interval: "15m" }),
    { on: "message_posted" },
  );
});

test("switching to a schedule trigger clears threaded replies on every step", () => {
  const state = {
    ...DEFAULT_FORM_STATE,
    name: "Switch",
    trigger: { on: "message_posted", filter: "true" },
    steps: [
      { id: "s1", action: "send_message", text: "hi", replyInThread: true },
      { id: "s2", action: "delay", duration: "1m", replyInThread: true },
      { id: "s3", action: "send_message", text: "bye" },
    ],
  };
  const scheduled = withTriggerType(state, "schedule");
  assert.deepEqual(scheduled.trigger, { on: "schedule" });
  assert.deepEqual(
    scheduled.steps.map((step) => step.replyInThread),
    [false, false, undefined],
  );
  assert.equal(scheduled.steps[2], state.steps[2]);

  const reverted = withTriggerType(state, "diff_posted");
  assert.deepEqual(reverted.trigger, { on: "diff_posted" });
  assert.equal(reverted.steps, state.steps);
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
      "zero timeout",
      `name: Test\ntrigger: { on: message_posted }\nsteps: [{ id: s1, timeout_secs: 0, action: send_message, text: hi }]\n`,
    ],
    [
      "fractional timeout",
      `name: Test\ntrigger: { on: message_posted }\nsteps: [{ id: s1, timeout_secs: 1.5, action: send_message, text: hi }]\n`,
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

test("webhook triggers carry only `on`, refuse threaded replies and serialize nothing else", () => {
  assert.equal(isThreadReplyEligibleTrigger("webhook"), false);
  for (const field of [
    "filter: 'true'",
    "emoji: eyes",
    "cron: '0 9 * * *'",
    "secret: abc",
  ]) {
    const yaml = `# retained\nname: Hook\ntrigger: { on: webhook, ${field} }\nsteps: [{ id: s1, action: send_message, text: hi }]\n`;
    const result = yamlToFormState(yaml);
    assert.equal(result.ok, false);
    assert.match(
      result.error,
      /^Unsupported webhook trigger field "\w+" — use the YAML editor$/,
    );
    assert.match(yaml, /# retained/);
  }
  const refused = yamlToFormState(
    `name: Hook\ntrigger: { on: webhook }\nsteps: [{ id: s1, action: send_message, text: hi, reply_in_thread: true }]\n`,
  );
  assert.equal(refused.ok, false);
  assert.equal(
    refused.error,
    "reply_in_thread is not supported for webhook triggers — use the YAML editor",
  );
  const explicitFalse = accepted(
    `name: Hook\ntrigger: { on: webhook }\nsteps: [{ id: s1, action: send_message, text: hi, reply_in_thread: false }]\n`,
  );
  // The parser fills every trigger key; only `on` may carry a value.
  assert.deepEqual(JSON.parse(JSON.stringify(explicitFalse.trigger)), {
    on: "webhook",
  });
  assert.equal(explicitFalse.steps[0].replyInThread, false);
  const switched = withTriggerType(
    sendMessageState({ replyInThread: true }),
    "webhook",
  );
  assert.deepEqual(switched.trigger, { on: "webhook" });
  assert.equal(switched.steps[0].replyInThread, false);
  const generated = parseYaml(formStateToYaml(switched));
  assert.deepEqual(generated.trigger, { on: "webhook" });
  assert.equal(generated.steps[0].reply_in_thread, undefined);
  // Stale trigger fields left in state never reach the YAML for a webhook.
  assert.deepEqual(
    parseYaml(
      formStateToYaml({
        ...switched,
        trigger: { on: "webhook", filter: "stale", emoji: "eyes" },
      }),
    ).trigger,
    { on: "webhook" },
  );
});

test("unsupported legacy actions remain YAML-only without parsing into form state", () => {
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

test("step IDs fill the first gap without interpreting numeric suffixes", () => {
  const steps = ["step_9007199254740992", "step_1", "step_3"].map((id) => ({
    id,
    action: "delay",
    duration: "1s",
  }));
  assert.equal(nextStepId(steps), "step_2");
  assert.equal(nextStepId([]), "step_1");
});

test("invalid nonblank timeout text survives serialization for validation", () => {
  for (const timeoutSecs of ["oops", "0s", "1.5", "9007199254740992"]) {
    assert.equal(
      parseYaml(formStateToYaml(sendMessageState({ timeoutSecs }))).steps[0]
        .timeout_secs,
      timeoutSecs,
    );
  }
  for (const timeoutSecs of [undefined, "", " "]) {
    assert.equal(
      parseYaml(formStateToYaml(sendMessageState({ timeoutSecs }))).steps[0]
        .timeout_secs,
      undefined,
    );
  }
});

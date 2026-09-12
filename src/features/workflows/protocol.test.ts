import { expect, it } from "vitest";
import {
  isWorkflowOperation,
  validateWorkflowEvent,
  parseRuns,
  parseApprovals,
  workflowYaml,
} from "./protocol";
const owner = "a".repeat(64),
  id = "11111111-1111-4111-8111-111111111111",
  runId = "22222222-2222-4222-8222-222222222222";
const yaml =
  "name: Fixture\nenabled: false\ntrigger:\n  on: message_posted\nsteps:\n  - id: 1_send\n    action: send_message\n    text: Hi\n";
const base = {
  id: "b".repeat(64),
  pubkey: owner,
  created_at: 1,
  kind: 30620,
  tags: [
    ["h", id],
    ["d", id],
  ],
  content: yaml,
};
it("strict authoring boundary rejects malformed coordinates/tags and webhook raw bypass, without taking generic deletions", () => {
  expect(
    validateWorkflowEvent(base, owner, { delete: true, webhookSecrets: false }),
  ).toEqual({ id, owner, channelId: id });
  for (const event of [
    { ...base, pubkey: "c".repeat(64) },
    {
      ...base,
      tags: [
        ["h", "../"],
        ["d", id],
      ],
    },
    { ...base, tags: [...base.tags, ["d", id]] },
    { ...base, tags: [...base.tags, ["client-id", "x"], ["client-id", "y"]] },
    { ...base, tags: [...base.tags, ["expected-revision", "bad"]] },
    { ...base, content: yaml.replace("message_posted", "webhook") },
    { ...base, kind: 46020 },
    { ...base, created_at: Infinity },
  ])
    expect(() =>
      validateWorkflowEvent(event, owner, {
        delete: true,
        webhookSecrets: false,
      }),
    ).toThrow();
  expect(isWorkflowOperation({ kind: 5, tags: [["e", "b".repeat(64)]] })).toBe(
    false,
  );
  expect(
    isWorkflowOperation({ kind: 5, tags: [["a", `30620:${owner}:${id}`]] }),
  ).toBe(true);
  expect(() =>
    validateWorkflowEvent(
      {
        ...base,
        kind: 5,
        content: "",
        tags: [
          ["h", id],
          ["a", `30620:${owner}:${id}`],
        ],
      },
      owner,
      { delete: false, webhookSecrets: false },
    ),
  ).toThrow("deletion");
});
it("YAML remains unchanged and malformed input/duplicate steps are rejected", () => {
  expect(workflowYaml(yaml)).toMatchObject({ enabled: false });
  for (const text of [
    "[]",
    yaml.replace("enabled: false", ""),
    yaml.replace("1_send", "my-step"),
    `${yaml}  - id: 1_send\n    action: delay\n    duration: 1s\n`,
    "x".repeat(24001),
    "name: [bad",
  ]) {
    expect(() => workflowYaml(text)).toThrow();
  }
});
it("run/approval rows require matching identities and preserve exact cursor precision", () => {
  const row = {
    id: runId,
    workflow_id: id,
    status: "completed",
    current_step: 1,
    execution_trace: [],
    started_at: 1,
    completed_at: 2,
    created_at: 1,
    error_code: null,
    error_message: null,
  };
  const before = "2026-09-12T14:44:19.123456+00:00";
  const raw = { runs: [row], next: { before, before_id: runId } };
  expect(parseRuns(raw, id).next).toEqual({ before, beforeId: runId });
  for (const value of [
    { ...raw, runs: [row, row] },
    { ...raw, runs: [{ ...row, workflow_id: runId }] },
    { ...raw, runs: [{ ...row, status: "imaginary" }] },
    { ...raw, next: { before } },
    { ...raw, runs: Array(21).fill(row) },
  ]) {
    expect(() => parseRuns(value, id)).toThrow();
  }
  const approval = {
    workflow_id: id,
    run_id: runId,
    approval_ref: owner,
    step_id: "a",
    status: "pending",
    created_at: 1,
    note: null,
  };
  expect(
    parseApprovals({ approvals: [approval] }, id, runId)[0]?.reference,
  ).toBe(owner);
  expect(() =>
    parseApprovals({ approvals: [{ ...approval, run_id: id }] }, id, runId),
  ).toThrow();
});

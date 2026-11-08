import { expect, it } from "vitest";
import example from "./example.json";
import { agentUiDraft, parseAgentUi } from "./spec";

const source = JSON.stringify(example);

it("copies current fields in tree order", () => {
  const spec = parseAgentUi(source);
  expect(spec).not.toBeNull();
  if (!spec) throw new Error("Example must parse");
  expect(agentUiDraft(spec, { subject: "Edited", body: "Current body" })).toBe(
    "Subject: Edited\n\nBody: Current body",
  );
});

it("requires draft fields for copy buttons while allowing read-only cards", () => {
  const readOnly = {
    ...example,
    state: {},
    elements: {
      draft: { ...example.elements.draft, children: ["intro", "comparison"] },
      intro: example.elements.intro,
      comparison: example.elements.comparison,
    },
  };
  expect(parseAgentUi(JSON.stringify(readOnly))).not.toBeNull();
  const withoutFields = {
    ...readOnly,
    elements: {
      ...readOnly.elements,
      draft: {
        ...readOnly.elements.draft,
        children: [...readOnly.elements.draft.children, "copy"],
      },
      copy: example.elements.copy,
    },
  };
  expect(parseAgentUi(JSON.stringify(withoutFields))).toBeNull();
});

it("rejects broken trees, unsafe properties, actions and bindings", () => {
  const invalid = [
    { ...example, version: 2 },
    {
      ...example,
      elements: {
        ...example.elements,
        draft: { ...example.elements.draft, children: ["missing"] },
      },
    },
    {
      ...example,
      elements: {
        ...example.elements,
        draft: { ...example.elements.draft, children: ["draft"] },
      },
    },
    {
      ...example,
      elements: {
        ...example.elements,
        draft: {
          ...example.elements.draft,
          children: [...example.elements.draft.children, "subject"],
        },
      },
    },
    {
      ...example,
      elements: {
        ...example.elements,
        copy: {
          ...example.elements.copy,
          props: { label: "Send", action: "sendEmail" },
        },
      },
    },
    {
      ...example,
      elements: {
        ...example.elements,
        copy: {
          ...example.elements.copy,
          on: { press: { action: "navigate" } },
        },
      },
    },
    {
      ...example,
      elements: {
        ...example.elements,
        body: {
          ...example.elements.body,
          props: { label: "Body", value: { $bindState: "/account/token" } },
        },
      },
    },
    { ...example, state: {} },
    {
      ...example,
      elements: {
        ...example.elements,
        intro: { ...example.elements.intro, type: "iframe" },
      },
    },
    {
      ...example,
      elements: {
        ...example.elements,
        intro: {
          ...example.elements.intro,
          props: { text: "hello", style: { color: "red" } },
        },
      },
    },
    {
      ...example,
      elements: {
        ...example.elements,
        comparison: {
          ...example.elements.comparison,
          props: { columns: ["A", "B"], rows: [["wrong width"]] },
        },
      },
    },
  ];
  for (const value of invalid)
    expect(parseAgentUi(JSON.stringify(value))).toBeNull();
  expect(parseAgentUi("{broken")).toBeNull();
  expect(parseAgentUi(" ".repeat(32_769))).toBeNull();
});

it("bounds payloads in UTF-8 bytes even below the character limit", () => {
  const oversized = {
    ...example,
    state: {
      ...example.state,
      a: "€".repeat(4000),
      b: "€".repeat(4000),
      c: "€".repeat(4000),
    },
  };
  const payload = JSON.stringify(oversized);
  expect(payload.length).toBeLessThan(32_768);
  expect(parseAgentUi(payload)).toBeNull();
});

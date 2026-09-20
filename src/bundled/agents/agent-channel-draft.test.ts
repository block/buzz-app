// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { appendAgentMention, prepareAgentDraft } from "./agent-channel-draft";
import { readView, writeView } from "../../shared/view-state";

const agent = { name: "Princess Donut", pubkey: "ab".repeat(32) };
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
it("appends an exact identity without replacing prose or existing recipients", () => {
  const first = appendAgentMention("My draft", {
    ...agent,
    pubkey: "cd".repeat(32),
  });
  const next = appendAgentMention(first, agent);
  expect(next.text).toBe("My draft @Princess Donut @Princess Donut ");
  expect(next.recipients).toEqual([
    ...first.recipients,
    { ...agent, start: 25, end: 40 },
  ]);
  expect(appendAgentMention(next, agent)).toEqual(next);
});
it("preserves the destination channel and thread drafts, and does not select by name", () => {
  writeView("other-community", "draft:channel", "Other community");
  writeView("scope", "draft:channel:thread:root", "Thread draft");
  writeView("scope", "draft:channel", "@Princess Donut typed only");
  prepareAgentDraft("scope", "channel", agent);
  expect(readView("scope", "draft:channel", null)).toMatchObject({
    text: "@Princess Donut typed only @Princess Donut ",
    recipients: [{ ...agent, start: 27, end: 42 }],
  });
  expect(readView("scope", "draft:channel:thread:root", null)).toBe(
    "Thread draft",
  );
  expect(readView("other-community", "draft:channel", null)).toBe(
    "Other community",
  );
});
it("rejects invalid identity, oversized text and a full recipient list without truncation", () => {
  expect(() => appendAgentMention("keep", { ...agent, pubkey: "bad" })).toThrow(
    /identity/,
  );
  expect(() => appendAgentMention("x".repeat(16000), agent)).toThrow(
    /too long/,
  );
  let value = appendAgentMention("", {
    name: "Other",
    pubkey: "00".repeat(32),
  });
  for (let n = 1; n < 32; n++)
    value = appendAgentMention(value, {
      name: "Other",
      pubkey: n.toString(16).padStart(64, "0"),
    });
  expect(() => appendAgentMention(value, agent)).toThrow(/32 recipients/);
});
it("does not replace an unreadable draft and reports denied storage writes", () => {
  const key = `buzz-view.v1:${JSON.stringify(["scope", "draft:channel"])}`;
  localStorage.setItem(key, "malformed-json");
  expect(() => prepareAgentDraft("scope", "channel", agent)).toThrow(
    /read the existing draft/,
  );
  expect(localStorage.getItem(key)).toBe("malformed-json");
  writeView("scope", "draft:channel", "Keep me");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  expect(() => prepareAgentDraft("scope", "channel", agent)).toThrow(
    /save the mention draft/,
  );
  expect(readView("scope", "draft:channel", null)).toBe("Keep me");
});

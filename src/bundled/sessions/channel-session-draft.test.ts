// @vitest-environment jsdom
import { afterEach, assert, expect, it } from "vitest";
import {
  readChannelSessionDraft,
  saveChannelSessionDraft,
} from "./channel-session-draft";
import {
  projectComposerDocument,
  readComposerDocument,
} from "../../features/messages/composer-document";
import {
  sessionCommandDraft,
  sessionCommandContent,
} from "../../features/sessions/session-command";
const scope = "draft-record-tests",
  channel = "general";
const rawDraft = {
  text: "/session @Agent help",
  recipients: [{ pubkey: "a".repeat(64), name: "Agent", start: 9, end: 15 }],
};
const draft = sessionCommandDraft(rawDraft);
assert.exists(draft);
const quiet = {
  id: "11111111-1111-4111-8111-111111111111",
  createdAt: 1,
  draft,
};
const command = {
  ...quiet,
  rawDraft,
  presentation: "chip" as const,
  scope,
  channelId: channel,
  viewer: "b".repeat(64),
  generation: 0,
};
afterEach(() => localStorage.clear());
it("keeps the old quiet namespace compatible but rejects all chip-command fields on read and write", () => {
  saveChannelSessionDraft(scope, channel, quiet);
  expect(readChannelSessionDraft(scope, channel)).toEqual(quiet);
  for (const fields of [
    { presentation: "chip" as const },
    { rawDraft },
    { content: "wire" },
    { scope },
    { generation: 0 },
    { viewer: command.viewer },
    { channelId: channel },
    { accepted: true },
  ]) {
    expect(() =>
      saveChannelSessionDraft(scope, channel, { ...quiet, ...fields }),
    ).toThrow(/invalid/);
    localStorage.setItem(
      `buzz-channel-session.v1:${JSON.stringify([scope, channel])}`,
      JSON.stringify({ ...quiet, ...fields }),
    );
    expect(() => readChannelSessionDraft(scope, channel)).toThrow(/invalid/);
  }
});
it("accepts an exactly stripped scoped command and validates the same schema before every write and read", () => {
  saveChannelSessionDraft(scope, channel, command, "command");
  expect(readChannelSessionDraft(scope, channel, "command")).toEqual(command);
  const bad = [
    { scope: "other" },
    { content: "incorrect payload" },
    { viewer: "bad" },
    { channelId: "other" },
    { generation: -1 },
    { generation: Number.MAX_SAFE_INTEGER },
    { draft: { ...draft, text: "wrong" } },
    { presentation: "quiet" as const },
    { rawDraft: { ...rawDraft, text: "/sessions @Agent help" } },
    { accepted: true },
  ];
  for (const fields of bad) {
    expect(() =>
      saveChannelSessionDraft(
        scope,
        channel,
        { ...command, ...fields },
        "command",
      ),
    ).toThrow(/invalid/);
    localStorage.setItem(
      `buzz-channel-session-command.v1:${JSON.stringify([scope, channel])}`,
      JSON.stringify({ ...command, ...fields }),
    );
    expect(() => readChannelSessionDraft(scope, channel, "command")).toThrow(
      /invalid/,
    );
  }
});

it("accepts reordered JSON members without migrating legacy content or dropping raw document correlation", () => {
  const rich = projectComposerDocument(
    readComposerDocument(rawDraft, rawDraft.recipients),
  ).draft;
  const record = {
    ...command,
    rawDraft: {
      recipients: rich.recipients,
      text: rich.text,
      document: rich.document,
    },
  };
  saveChannelSessionDraft(scope, channel, record, "command");
  expect(readChannelSessionDraft(scope, channel, "command")).toEqual(record);
  const modern = { ...record, content: sessionCommandContent(rich) };
  saveChannelSessionDraft(scope, channel, modern, "command");
  expect(readChannelSessionDraft(scope, channel, "command")).toEqual(modern);
});

// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readView, writeView } from "../../shared/view-state";
import type { ChannelMessage } from "../relay/contracts";
import { useKeptEdit } from "./use-kept-edit";

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

const message = (id: string): ChannelMessage => ({
  id,
  channelId: "channel",
  authorId: "viewer",
  createdAt: 10,
  content: "Original message",
  replyCount: 0,
  participants: [],
  mentions: [],
  attachments: [],
  reactions: [],
});
const keep = (id: string, text: string) =>
  writeView("scope", "edit:channel", {
    id,
    base: "Original message",
    draft: { text, recipients: [] },
  });

it("discards only the kept rewrite its confirmation names", () => {
  const chosen = message("b".repeat(64));
  const editableRow = (id: string) => (id === chosen.id ? chosen : undefined);
  const { result } = renderHook(() =>
    useKeptEdit({
      scope: "scope",
      key: "edit:channel",
      resume: false,
      find: () => undefined,
      subscribe: () => () => {},
      ready: true,
      blocked: false,
      reopen: () => true,
      close: () => {},
    }),
  );
  const older = "a".repeat(64);
  keep(older, "Rewritten older");
  // Without a confirmation naming it, as after another report replaced the
  // notice, Edit only asks again.
  for (let i = 0; i < 2; i++)
    expect(result.current.open(chosen, editableRow, false, undefined)).toEqual({
      discard: older,
    });
  // The record now holds a rewrite of another message, as from another window.
  const other = "c".repeat(64);
  keep(other, "Rewritten other");
  expect(result.current.open(chosen, editableRow, false, older)).toEqual({
    discard: other,
  });
  expect(readView("scope", "edit:channel", null)).toMatchObject({
    id: other,
    draft: { text: "Rewritten other" },
  });
  expect(result.current.open(chosen, editableRow, false, other)).toEqual({
    row: chosen,
    kept: undefined,
    redirected: false,
  });
  expect(readView("scope", "edit:channel", null)).toBeNull();
});

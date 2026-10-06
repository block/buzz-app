import { expect, it } from "vitest";
import type { RelaySession } from "../relay/session";
import { mentionAdmits } from "./mention-admission";

const member = "a".repeat(64);
const outside = "b".repeat(64);
const library = "c".repeat(64);
const archived = "e".repeat(64);

function session(
  channel: Record<string, unknown> | undefined,
  viewer?: string,
): RelaySession {
  return {
    viewer,
    channels: {
      list: () => ({
        status: "ready",
        channels: channel
          ? [{ id: "channel", members: [member], ...channel }]
          : [],
      }),
    },
    agentChoices: {
      snapshot: () => ({ identities: [{ pubkey: library, name: "Honey" }] }),
    },
    archives: {
      state: (key: string) => (key === archived ? "archived" : "active"),
    },
  } as unknown as RelaySession;
}

it("admits any valid key where outside people can be named", () => {
  for (const channelType of ["stream", "forum", "dm", undefined]) {
    const s = session({ channelType });
    expect(mentionAdmits(s, "channel", member)).toBe(true);
    // Not offered by any chooser; delivery asks before addressing it.
    expect(mentionAdmits(s, "channel", outside)).toBe(true);
  }
});

it("keeps session, roster and agent-invite limits", () => {
  const sessionChannel = session({ channelType: "session" });
  expect(mentionAdmits(sessionChannel, "channel", member)).toBe(true);
  expect(mentionAdmits(sessionChannel, "channel", outside)).toBe(false);
  expect(mentionAdmits(sessionChannel, "channel", library)).toBe(false);
  expect(mentionAdmits(sessionChannel, "channel", library, true)).toBe(true);
  expect(mentionAdmits(sessionChannel, "channel", outside, true)).toBe(false);
  const dm = session({ channelType: "dm" });
  expect(mentionAdmits(dm, "channel", library, true)).toBe(false);
  const roster = [{ pubkey: outside, name: "Wes" }];
  expect(
    mentionAdmits(session(undefined), "draft", outside, false, roster),
  ).toBe(true);
  expect(
    mentionAdmits(session(undefined), "draft", member, false, roster),
  ).toBe(false);
  expect(mentionAdmits(session(undefined), "unknown", outside)).toBe(false);
});

it("refuses invalid keys, archived identities and closed destinations", () => {
  const stream = session({ channelType: "stream" });
  expect(mentionAdmits(stream, "channel", "A".repeat(64))).toBe(false);
  expect(mentionAdmits(stream, "channel", "abc")).toBe(false);
  expect(mentionAdmits(stream, "channel", archived)).toBe(false);
  expect(
    mentionAdmits(
      session({ channelType: "stream" }, archived),
      "channel",
      archived,
    ),
  ).toBe(true);
  for (const closed of [{ archived: true }, { readOnly: true }])
    expect(
      mentionAdmits(
        session({ channelType: "stream", ...closed }),
        "channel",
        member,
      ),
    ).toBe(false);
});

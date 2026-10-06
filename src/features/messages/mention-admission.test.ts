import { expect, it } from "vitest";
import type { RelaySession } from "../relay/session";
import { mentionAdmission } from "./mention-admission";

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
          ? [{ id: "channel", members: [member, archived], ...channel }]
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
  for (const channelType of ["stream", "forum", "dm"]) {
    const admits = mentionAdmission(session({ channelType }), "channel");
    expect(admits(member)).toBe(true);
    // Not offered by any chooser; delivery asks before addressing it.
    expect(admits(outside)).toBe(true);
  }
});

it("keeps session, roster and agent-invite limits", () => {
  const sessionChannel = session({ channelType: "session" });
  const plain = mentionAdmission(sessionChannel, "channel");
  expect(plain(member)).toBe(true);
  expect(plain(outside)).toBe(false);
  expect(plain(library)).toBe(false);
  const inviting = mentionAdmission(sessionChannel, "channel", true);
  expect(inviting(library)).toBe(true);
  expect(inviting(outside)).toBe(false);
  // Agent invitation never admits directory people, even in a stream.
  expect(
    mentionAdmission(
      session({ channelType: "stream" }),
      "channel",
      true,
    )(outside),
  ).toBe(false);
  expect(
    mentionAdmission(session({ channelType: "dm" }), "channel", true)(library),
  ).toBe(false);
  const roster = [{ pubkey: outside, name: "Wes" }];
  const draft = mentionAdmission(session(undefined), "draft", false, roster);
  expect(draft(outside)).toBe(true);
  expect(draft(member)).toBe(false);
  expect(mentionAdmission(session(undefined), "unknown")(outside)).toBe(false);
});

it("refuses invalid keys, archived identities and closed destinations", () => {
  const admits = mentionAdmission(
    session({ channelType: "stream" }),
    "channel",
  );
  expect(admits("A".repeat(64))).toBe(false);
  expect(admits("abc")).toBe(false);
  expect(admits(archived)).toBe(false);
  const viewer = session({ channelType: "session" }, archived);
  expect(mentionAdmission(viewer, "channel")(archived)).toBe(true);
  for (const closed of [{ archived: true }, { readOnly: true }])
    expect(
      mentionAdmission(
        session({ channelType: "stream", ...closed }),
        "channel",
      )(member),
    ).toBe(false);
});

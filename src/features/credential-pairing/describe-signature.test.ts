import { npubEncode } from "nostr-tools/nip19";
import { expect, it } from "vitest";
import { describeSignature } from "./describe-signature";

const channel = "0b6b3a8e-1d7c-4f0e-9a52-6a1f0c5d2e77";
const pubkey = "ab".repeat(32);
const lookup = {
  channel: (id: string) => (id === channel ? "general" : undefined),
  person: (key: string) => (key === pubkey ? "Alex" : undefined),
};

it("names a channel it knows, and a short id for one it does not", () => {
  expect(describeSignature(9022, [["h", channel]], lookup).action).toBe(
    "leave #general",
  );
  expect(describeSignature(9022, [["h", channel]]).action).toBe(
    "leave channel 0b6b3a8e",
  );
  expect(describeSignature(9022, [], lookup).action).toBe("leave a channel");
});

it("never takes a deletion's claimed kind as what it deletes", () => {
  expect(
    describeSignature(5, [
      ["e", "x"],
      ["k", "7"],
    ]).action,
  ).toBe("delete something you or your agents posted");
  expect(describeSignature(5, [["a", "30620:key:flow"]]).action).toBe(
    "delete something you or your agents posted",
  );
  expect(
    describeSignature(5, [
      ["e", "x"],
      ["e", "y"],
      ["a", "30620:key:flow"],
    ]).action,
  ).toBe("delete 3 things you or your agents posted");
});

it("names the person a moderation or membership change is about", () => {
  const tags = [
    ["h", channel],
    ["p", pubkey],
  ];
  expect(describeSignature(9000, tags, lookup).action).toBe(
    "add Alex to #general",
  );
  expect(describeSignature(9001, tags, lookup).action).toBe(
    "remove Alex from #general",
  );
  expect(describeSignature(9040, tags, lookup).action).toBe(
    "ban Alex from the community permanently",
  );
  expect(describeSignature(9041, tags, lookup).action).toBe("unban Alex");
  expect(describeSignature(9043, tags, lookup).action).toBe(
    "end the timeout for Alex",
  );
  expect(describeSignature(41011, [["p", pubkey]], lookup).action).toBe(
    "add Alex to a DM",
  );
});

it("falls back to a short npub for a person it cannot name, never the raw key", () => {
  const { action } = describeSignature(9000, [
    ["h", channel],
    ["p", pubkey],
  ]);
  expect(action).toBe(
    `add npub…${npubEncode(pubkey).slice(-3)} to channel 0b6b3a8e`,
  );
  expect(action).not.toContain(pubkey);
  expect(describeSignature(9001, [["p", "not a key"]]).action).toBe(
    "remove someone from a channel",
  );
});

it("sums up several people", () => {
  const other = "cd".repeat(32);
  const third = "ef".repeat(32);
  const names = {
    person: (key: string) => ({ [pubkey]: "Alex", [other]: "Sam" })[key],
  };
  expect(
    describeSignature(
      9000,
      [
        ["p", pubkey],
        ["p", other],
      ],
      names,
    ).action,
  ).toBe("add Alex and Sam to a channel");
  expect(
    describeSignature(
      9000,
      [
        ["p", pubkey],
        ["p", other],
        ["p", third],
      ],
      names,
    ).action,
  ).toBe("add Alex and 2 others to a channel");
  expect(
    describeSignature(
      9000,
      [
        ["p", pubkey],
        ["p", pubkey],
      ],
      names,
    ).action,
  ).toBe("add Alex to a channel");
});

it("says what an edit changes", () => {
  const h = ["h", channel];
  const edit = (...tags: string[][]) =>
    describeSignature(9002, [h, ...tags], lookup).action;
  expect(edit(["archived", "true"])).toBe("archive #general");
  expect(edit(["archived", "false"])).toBe("unarchive #general");
  expect(edit(["auto_join", "true"])).toBe("turn auto-join on for #general");
  expect(edit(["auto_join", "false"])).toBe("turn auto-join off for #general");
  expect(edit(["name", "new"])).toBe("rename #general");
  expect(edit(["about", "x"])).toBe("change the description of #general");
  expect(edit(["name", "new"], ["about", "x"])).toBe(
    "edit #general: rename it and change its description",
  );
  expect(edit()).toBe("edit #general");
});

it("names every edit the relay makes, not just the first", () => {
  const edit = (...tags: string[][]) =>
    describeSignature(9002, [["h", channel], ...tags], lookup).action;
  expect(edit(["visibility", "private"])).toBe("make #general private");
  expect(edit(["join_role", "guest"])).toBe(
    "make people who join #general guests who can't post",
  );
  expect(edit(["unlisted", "true"])).toBe(
    "hide #general from the channel list",
  );
  expect(edit(["ttl", "60"])).toBe("make messages in #general disappear");
  expect(edit(["t", "ops"])).toBe("change the labels of #general");
  expect(edit(["archived", "true"], ["visibility", "private"])).toBe(
    "edit #general: archive it and make it private",
  );
  expect(
    edit(["name", "x"], ["visibility", "open"], ["auto_join", "true"]),
  ).toBe(
    "edit #general: rename it, make it open to everyone and turn auto-join on for it",
  );
});

it("names the role a member addition grants", () => {
  const h = ["h", channel];
  const add = (...tags: string[][]) =>
    describeSignature(9000, [h, ...tags], lookup).action;
  expect(add(["p", pubkey], ["role", "owner"])).toBe(
    "add Alex to #general as an owner",
  );
  expect(add(["p", pubkey, "admin"])).toBe("add Alex to #general as an admin");
  // A role on the person outranks the fallback, as the relay reads it.
  expect(add(["p", pubkey, "admin"], ["role", "member"])).toBe(
    "add Alex to #general as an admin",
  );
  expect(add(["p", pubkey, "guest"], ["p", "cd".repeat(32), "owner"])).toMatch(
    / with different roles$/,
  );
  expect(add(["p", pubkey])).toBe("add Alex to #general");
});

it("says how long a ban or timeout lasts", () => {
  const p = ["p", pubkey];
  const at = 1_800_000_000;
  const when = new Date(at * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  expect(
    describeSignature(9040, [p, ["expiration", `${at}`]], lookup).action,
  ).toBe(`ban Alex from the community until ${when}`);
  expect(
    describeSignature(9042, [p, ["expiration", `${at}`]], lookup).action,
  ).toBe(`time out Alex until ${when}`);
  expect(
    describeSignature(9042, [p, ["expiration", "soon"]], lookup).action,
  ).toBe("time out Alex with other settings");
});

it("says when a deletion, creation or DM addition does more", () => {
  const h = ["h", channel];
  expect(
    describeSignature(9005, [h, ["e", "x"], ["reason_code", "spam"]], lookup)
      .action,
  ).toBe("delete a message as a moderator in #general");
  expect(
    describeSignature(9007, [
      ["name", "ops"],
      ["visibility", "private"],
      ["channel_type", "forum"],
    ]).action,
  ).toBe("create the private forum “ops”");
  expect(
    describeSignature(
      9007,
      [
        ["name", "ops"],
        ["p", pubkey],
        ["unlisted", "true"],
        ["ttl", "60"],
      ],
      lookup,
    ).action,
  ).toBe(
    "create the channel “ops”, with Alex, hidden from the channel list, where messages disappear",
  );
  expect(describeSignature(9007, [["channel_type", "system"]]).action).toBe(
    "create a private system channel",
  );
  expect(
    describeSignature(
      41011,
      [
        ["p", pubkey],
        ["history", "include"],
      ],
      lookup,
    ).action,
  ).toBe("add Alex to a DM and show them its history");
  expect(
    describeSignature(9044, [
      ["report", "x"],
      ["status", "resolved"],
      ["action", "ban"],
    ]).action,
  ).toBe("resolve a report and ban the person");
});

it("marks a named tag that repeats with another value", () => {
  const h = ["h", channel];
  expect(
    describeSignature(
      9002,
      [h, ["visibility", "private"], ["visibility", "open"]],
      lookup,
    ).action,
  ).toBe("make #general private with other settings");
  expect(
    describeSignature(9007, [
      ["name", "ops"],
      ["visibility"],
      ["visibility", "private"],
    ]).action,
  ).toBe("create the channel “ops” with other settings");
  expect(describeSignature(9022, [["h", "junk"], h], lookup).action).toBe(
    "leave channel junk with other settings",
  );
  expect(
    describeSignature(
      9002,
      [h, ["archived", "true"], ["archived", "true"]],
      lookup,
    ).action,
  ).toBe("archive #general");
});

it("marks a tag it does not put into words", () => {
  const h = ["h", channel];
  expect(describeSignature(9022, [h, ["x", "y"]], lookup).action).toBe(
    "leave #general with other settings",
  );
  expect(describeSignature(9022, [h, ["client", "cli"]], lookup).action).toBe(
    "leave #general",
  );
  // A kind that replaces the whole of something names it as a whole.
  expect(describeSignature(0, [["x", "y"]]).action).toBe("change your profile");
});

it("describes every kind that can be asked, with a general ability", () => {
  const asked = [
    0, 3, 5, 9000, 9001, 9002, 9003, 9004, 9005, 9006, 9007, 9008, 9009, 9021,
    9022, 9040, 9041, 9042, 9043, 9044, 10002, 10100, 28936, 30175, 30176,
    30177, 30179, 30617, 30618, 30620, 30621, 41011, 45011, 46030, 46031,
  ];
  for (const kind of asked) {
    const { action, ability } = describeSignature(kind, []);
    expect(action, `${kind}`).not.toMatch(/kind/);
    expect(ability, `${kind}`).not.toMatch(/kind/);
  }
  expect(describeSignature(9022, [])).toEqual({
    action: "leave a channel",
    ability: "leave channels",
  });
  expect(describeSignature(28936, []).action).toBe("leave the community");
  expect(describeSignature(9009, [["h", channel]], lookup).action).toBe(
    "change admin settings for #general",
  );
  expect(describeSignature(9007, [["name", "ops"]]).action).toBe(
    "create the channel “ops”",
  );
});

it("falls back for a kind it does not know", () => {
  expect(describeSignature(31234, [["h", channel]], lookup)).toEqual({
    action: "sign a kind 31234 event",
    ability: "sign kind 31234 events",
  });
});

it("clips a long name and never reads content", () => {
  const long = "x".repeat(200);
  const { action } = describeSignature(9022, [["h", channel]], {
    channel: () => long,
  });
  expect(action).toBe(`leave #${"x".repeat(60)}…`);
  // A tag named like content is not a tag the words come from.
  expect(
    describeSignature(
      9022,
      [
        ["content", "secret"],
        ["h", channel],
      ],
      lookup,
    ).action,
  ).not.toContain("secret");
});

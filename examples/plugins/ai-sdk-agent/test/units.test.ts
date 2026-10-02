import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.ts";
import { fold, messageTags, threadRoot } from "../src/thread.ts";

const id = (letter: string) => letter.repeat(64);

test("saved config of any shape becomes a usable config, without a key", () => {
  assert.deepEqual(parseConfig(undefined), parseConfig({}));
  // A config saved before the key became a secret still has it; it is dropped.
  assert.deepEqual(parseConfig({ provider: "nope", apiKey: " k ", model: 4 }), {
    provider: "anthropic",
    model: "",
    instructions: parseConfig({}).instructions,
  });
  assert.equal(parseConfig({ provider: "openai" }).provider, "openai");
});

test("a reply lands in the thread of the message it answers", () => {
  const top = { id: id("a"), tags: [["h", "c"]] };
  const reply = {
    id: id("b"),
    tags: [
      ["h", "c"],
      ["e", id("a"), "", "reply"],
    ],
  };
  const nested = {
    id: id("c"),
    tags: [
      ["h", "c"],
      ["e", id("a"), "", "root"],
      ["e", id("b"), "", "reply"],
    ],
  };
  assert.equal(threadRoot(top), id("a"));
  assert.equal(threadRoot(reply), id("a"));
  assert.equal(threadRoot(nested), id("a"));
  assert.deepEqual(messageTags("c", id("a"), [id("d"), id("d")]), [
    ["h", "c"],
    ["e", id("a"), "", "reply"],
    ["p", id("d")],
  ]);
  assert.deepEqual(messageTags("c"), [["h", "c"]]);
  assert.throws(() => messageTags("c", "not-an-id"));
  assert.throws(() => messageTags("c", undefined, ["@alice"]));
});

test("a read shows each message as its author last left it", () => {
  const event = (
    name: string,
    kind: number,
    pubkey: string,
    created_at: number,
    content: string,
    target?: string,
  ) => ({
    id: id(name),
    kind,
    pubkey,
    created_at,
    content,
    tags: [["h", "c"], ...(target ? [["e", id(target), "", "reply"]] : [])],
  });
  const shown = fold([
    event("b", 9, "bot", 20, "Hel", "a"),
    event("a", 9, "ann", 10, "question"),
    event("1", 40003, "bot", 22, "Hello there", "b"),
    event("2", 40003, "bot", 21, "Hello", "b"),
    event("3", 40003, "eve", 30, "forged", "b"),
    event("d", 9, "ann", 30, "oops"),
    event("4", 5, "ann", 31, "", "d"),
    event("5", 5, "eve", 32, "", "a"),
  ]);
  assert.deepEqual(shown, [
    { id: id("a"), pubkey: "ann", created_at: 10, content: "question" },
    {
      id: id("b"),
      pubkey: "bot",
      created_at: 20,
      content: "Hello there",
      thread: id("a"),
    },
  ]);
});

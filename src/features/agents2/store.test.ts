import { expect, it } from "vitest";
import {
  STORAGE_KEY,
  readRecords,
  setAttention,
  writeRecords,
  type AgentRecord,
} from "./store";
import { memoryStorage } from "./test-fakes";

const pubkey = "a".repeat(64);
const record: AgentRecord = {
  pubkey,
  type: "example/echo",
  name: "Echo",
  attention: {},
  config: { word: "hi" },
};

it("round-trips records and drops attention objects a reader would ignore", () => {
  const storage = memoryStorage();
  const saved = setAttention(
    record,
    "interest/default",
    { type: "interest", instructions: "Be brief." },
    7,
  );
  writeRecords(storage, { [pubkey]: saved });
  expect(readRecords(storage)).toEqual({ [pubkey]: saved });
  const stored = JSON.parse(storage.getItem(STORAGE_KEY) as string);
  stored.agents[pubkey].attention["watch/bad"] = {
    slug: "watch/bad",
    value: { type: "event" },
    modifiedAt: 1,
  };
  stored.agents.nonsense = record;
  storage.setItem(STORAGE_KEY, JSON.stringify(stored));
  expect(readRecords(storage)).toEqual({ [pubkey]: saved });
});

it("validates, replaces and deletes one object at a time", () => {
  expect(() =>
    setAttention(record, "interest/x", { type: "interest", instructions: " " }),
  ).toThrow(/empty/);
  const one = setAttention(
    record,
    "interest/x",
    { type: "interest", instructions: "a" },
    1,
  );
  const two = setAttention(
    one,
    "interest/x",
    { type: "interest", instructions: "b" },
    2,
  );
  expect(two.attention["interest/x"]).toEqual({
    slug: "interest/x",
    value: { type: "interest", instructions: "b" },
    modifiedAt: 2,
  });
  expect(setAttention(two, "interest/x", null).attention).toEqual({});
});

it("reads nothing from missing or malformed storage", () => {
  const storage = memoryStorage();
  expect(readRecords(storage)).toEqual({});
  storage.setItem(STORAGE_KEY, "{");
  expect(readRecords(storage)).toEqual({});
});

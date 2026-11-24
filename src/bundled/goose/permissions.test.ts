import { expect, it } from "vitest";
import { ownerAllows } from "./permissions";

const file = (text: string) => async () => new TextEncoder().encode(text);

it("reads the owner's saved denials and approvals each time it is asked", async () => {
  let saved =
    "user:\n  always_allow:\n  - shell\n  ask_before: []\n  never_allow: []\n";
  const read = async () => new TextEncoder().encode(saved);
  expect(await ownerAllows(read, "/p", "shell")).toBe(true);
  saved =
    "user:\n  always_allow: []\n  ask_before: []\n  never_allow:\n  - shell\n";
  expect(await ownerAllows(read, "/p", "shell")).toBe(false);
  expect(await ownerAllows(read, "/p", "write")).toBe(true);
  expect(
    await ownerAllows(file("user:\n  ask_before:\n  - write\n"), "/p", "write"),
  ).toBe(false);
});

it("saves nothing without a file, and allows nothing it can't read", async () => {
  const missing = async () => {
    throw new Error("No such file or directory (os error 2)");
  };
  expect(await ownerAllows(missing, "/p", "shell")).toBe(true);
  const denied = async () => {
    throw new Error("Permission denied (os error 13)");
  };
  expect(await ownerAllows(denied, "/p", "shell")).toBe(false);
  expect(await ownerAllows(file("user: [unclosed"), "/p", "shell")).toBe(false);
});

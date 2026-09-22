import { it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { communityPreference } from "./community-preference.mjs";
const directories = [];
afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "community-preference-"));
  directories.push(dir);
  return dir;
};
const viewer = "a".repeat(64);
it("independent brokers and restarts share only the same viewer's last choice", async () => {
  const dir = setup();
  const first = communityPreference(dir),
    second = communityPreference(dir);
  expect(first.read(viewer)).toBeNull();
  await first.write(viewer, {
    url: "wss://RELAY.example:443/",
    name: "Relay",
    selectedAt: 1,
    ignored: "not saved",
  });
  expect(second.read(viewer)).toEqual({
    url: "https://relay.example",
    name: "Relay",
    selectedAt: 1,
  });
  expect(second.read("b".repeat(64))).toBeNull();
  await second.write(viewer, {
    url: "https://other.example",
    name: "Other",
    selectedAt: 2,
  });
  expect(communityPreference(dir).read(viewer).name).toBe("Other");
  expect(readdirSync(dir)).toEqual([`${viewer}.json`]);
  if (process.platform !== "win32")
    expect(statSync(join(dir, `${viewer}.json`)).mode & 0o777).toBe(0o600);
});
it("corrupt, oversized and unsafe saved data never becomes a destination", async () => {
  const dir = setup(),
    store = communityPreference(dir);
  for (const raw of [
    "bad json",
    "x".repeat(4097),
    '{"url":"http://unsafe","name":"No"}',
    '{"url":"https://user:pass@example.com","name":"No"}',
  ]) {
    writeFileSync(join(dir, `${viewer}.json`), raw);
    expect(store.read(viewer)).toBeNull();
  }
  await expect(
    store.write("../escape", { url: "https://ok.example", name: "No" }),
  ).rejects.toThrow();
  await expect(
    store.write(viewer, { url: "https://ok.example", name: "x".repeat(257) }),
  ).rejects.toThrow();
});

it("a delayed older choice cannot replace a later selection across store instances", async () => {
  const dir = setup(),
    first = communityPreference(dir),
    second = communityPreference(dir);
  const older = { url: "https://old.example", name: "Old", selectedAt: 100 };
  const newer = { url: "https://new.example", name: "New", selectedAt: 200 };
  await second.write(viewer, newer);
  await first.write(viewer, older);
  expect(first.read(viewer)).toEqual(newer);
  await Promise.all([
    first.write(viewer, { ...older, selectedAt: 300 }),
    second.write(viewer, { ...newer, selectedAt: 400 }),
  ]);
  expect(first.read(viewer)).toEqual({ ...newer, selectedAt: 400 });
});

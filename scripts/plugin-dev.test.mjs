import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInboxDev,
  hostBuildId,
  inboxDependencies,
} from "./plugin-dev.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
let directory;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "inbox-dev-test-"));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("Inbox exports only runtime dependencies, never type-only services or its own source", async () => {
  const modules = await inboxDependencies();
  expect(modules.has("features/messages/MessageComposer")).toBe(true);
  expect(modules.has("shared/view-state")).toBe(true);
  expect(modules.has("features/relay/session")).toBe(false);
  expect(
    [...modules.keys()].some((key) => key.startsWith("bundled/inbox/")),
  ).toBe(false);
  expect([...modules.get("shared/view-state").names]).toContain(
    "subscribeView",
  );
});

test("builds an ordinary alternate artifact with CSS and host checks, without copied host code", async () => {
  const out = join(directory, "plugin");
  const result = await buildInboxDev({ out, id: "test.inbox-dev" });
  const code = await readFile(join(out, "plugin.js"), "utf8");
  expect(
    JSON.parse(await readFile(join(out, "manifest.json"), "utf8")),
  ).toEqual({ id: "test.inbox-dev", name: "Inbox Dev", apiVersion: 1 });
  expect(result.buildId).toBe(await hostBuildId());
  expect(code).toContain("__BUZZ_HOST_MODULES__");
  expect(code).toContain("style.remove()");
  expect(code).not.toContain("__BUZZ_INBOX_DEV_CSS__");
  expect(code).not.toContain("new WeakMap");
  await expect(
    import(
      `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
    ),
  ).rejects.toThrow("different Buzz host");
  // Rebuilds reuse the output folder but refuse to remove unrelated files.
  await buildInboxDev({ out, id: "test.inbox-dev" });
  await writeFile(join(out, "precious.txt"), "keep");
  await expect(buildInboxDev({ out, id: "test.inbox-dev" })).rejects.toThrow(
    "files other than",
  );
  expect(await readFile(join(out, "precious.txt"), "utf8")).toBe("keep");
});

test("refuses bundled identities and destructive output destinations", async () => {
  await expect(buildInboxDev({ id: "buzz.inbox" })).rejects.toThrow(
    "alternate plugin ID",
  );
  await expect(buildInboxDev({ out: root })).rejects.toThrow("source checkout");
  await expect(
    buildInboxDev({ out: join(root, "src/bundled/inbox") }),
  ).rejects.toThrow("source checkout");
});

import { afterAll, beforeAll, expect, test, vi } from "vitest";
import * as filesystem from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { win32 } from "node:path";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  // A host whose fingerprint could not be computed must never match an artifact.
  const previousHost = globalThis.__BUZZ_HOST_MODULES__;
  try {
    globalThis.__BUZZ_HOST_MODULES__ = { buildId: null, modules: {} };
    await expect(
      import(
        `data:text/javascript;base64,${Buffer.from(code).toString("base64")}#unavailable-host`
      ),
    ).rejects.toThrow("different Buzz host");
  } finally {
    if (previousHost === undefined) delete globalThis.__BUZZ_HOST_MODULES__;
    else globalThis.__BUZZ_HOST_MODULES__ = previousHost;
  }
  // Rebuilds reuse the output folder but refuse to remove unrelated files.
  await buildInboxDev({ out, id: "test.inbox-dev" });
  await writeFile(join(out, "precious.txt"), "keep");
  await expect(buildInboxDev({ out, id: "test.inbox-dev" })).rejects.toThrow(
    "files other than",
  );
  expect(await readFile(join(out, "precious.txt"), "utf8")).toBe("keep");
});

test("builds Inbox-only utilities against the host theme without resets or unrelated utilities", async () => {
  const checkout = join(directory, "checkout");
  for (const path of [
    "src",
    "scripts",
    "vite.config.ts",
    "package.json",
    "pnpm-lock.yaml",
    "postcss.config.js",
    ".gitignore",
  ])
    await cp(join(root, path), join(checkout, path), { recursive: true });
  await symlink(
    join(root, "node_modules"),
    join(checkout, "node_modules"),
    "dir",
  );
  execFileSync("git", ["init", "--quiet", checkout]);
  const out = join(directory, "utilities");
  const before = await buildInboxDev({ directory: checkout, out });
  const entry = join(checkout, "src/bundled/inbox/index.tsx");
  const utilities = [
    ["[word-spacing:", "3.7px]"].join(""),
    "p-13",
    "bg-muted",
    "dark:p-17",
    "animate-ping",
  ];
  await writeFile(
    entry,
    `${await readFile(entry, "utf8")}\n// ${utilities.join(" ")}\n`,
  );
  const after = await buildInboxDev({ directory: checkout, out });
  expect(after.buildId).toBe(before.buildId);
  const code = await readFile(join(out, "plugin.js"), "utf8");
  const css = JSON.parse(code.match(/style.textContent = (".*");/)[1]);
  expect(css).toContain("word-spacing: 3.7px");
  expect(css).toContain("padding: calc(var(--space-1) * 13)");
  expect(css).toContain("background-color: var(--text-muted)");
  expect(css).toContain('[data-color-mode="dark"]');
  expect(css).toContain("@keyframes ping");
  expect(css).not.toContain("@layer base");
  expect(css).not.toContain("box-sizing: border-box");
  expect(css).not.toContain(".panel-header");
  expect(css).not.toContain(".container {");
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

test.each([
  { message: "spawnSync git ENOENT", code: "ENOENT" },
  { message: "fatal: not a git repository", status: 128 },
])(
  "host builds survive unavailable Git metadata: $message",
  async (failure) => {
    vi.doMock("node:child_process", async (original) => ({
      ...(await original()),
      execFileSync: () => {
        throw Object.assign(new Error(failure.message), failure);
      },
    }));
    try {
      vi.resetModules();
      const source = await import("./plugin-dev.mjs");
      const warn = vi.fn();
      const generated = await source
        .inboxHostPlugin()
        .load.call({ warn }, "\0virtual:buzz-inbox-host");
      expect(generated).toContain("buildId: null");
      expect(generated).toContain('"features/messages/MessageComposer"');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Inbox Dev compatibility is unavailable"),
      );
      // An external artifact still requires a real fingerprint; null never matches.
      await expect(
        source.buildInboxDev({ out: join(directory, "without-git") }),
      ).rejects.toThrow(failure.message);
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  },
);

// Exercise Windows filesystem semantics on every host without a Windows-only job.
test("generates portable host imports with Windows filesystem paths", async () => {
  const windowsRoot = "C:\\buzz";
  const nativeRead = filesystem.readFile;
  const nativeExec = execFileSync;
  const localPath = (path) =>
    path.startsWith(windowsRoot)
      ? join(root, ...win32.relative(windowsRoot, path).split("\\"))
      : path;
  vi.doMock("node:path", async (original) => ({
    ...(await original()),
    ...win32,
  }));
  vi.doMock("node:fs/promises", async (original) => ({
    ...(await original()),
    readFile: (path, ...args) => nativeRead(localPath(path), ...args),
  }));
  vi.doMock("node:child_process", async (original) => ({
    ...(await original()),
    execFileSync: (file, args, options) =>
      nativeExec(file, args, { ...options, cwd: localPath(options.cwd) }),
  }));
  try {
    vi.resetModules();
    const windows = await import("./plugin-dev.mjs");
    const modules = await windows.inboxDependencies(windowsRoot);
    expect([...modules.keys()]).toEqual(
      [...(await inboxDependencies())].map(([key]) => key),
    );
    const host = windows.inboxHostPlugin(windowsRoot);
    expect(
      host.transform(
        "export const plugins = [];",
        "C:/buzz/src/bundled/index.ts",
      ),
    ).toContain("virtual:buzz-inbox-host");
    const generated = await host.load("\0virtual:buzz-inbox-host");
    expect(generated).toContain(
      'from "C:/buzz/src/features/messages/MessageComposer.tsx"',
    );
    expect(generated).not.toContain("bundled/inbox/InboxPage");
    expect(generated).not.toContain("\\\\");
  } finally {
    vi.doUnmock("node:path");
    vi.doUnmock("node:fs/promises");
    vi.doUnmock("node:child_process");
    vi.resetModules();
  }
});

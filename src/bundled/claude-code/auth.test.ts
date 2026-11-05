import { expect, it } from "vitest";
import type { HostProcessOptions } from "../../features/host/service";
import { ClaudeAuth } from "./auth";
import { ENV, type Spawn } from "./claude";

const KEY = "sk-ant-api03-saved";

/** A host whose `claude.sh key` prints `saved.key`; every start is recorded. */
function host(saved: { key: string }) {
  const started: { id: string; options: HostProcessOptions | undefined }[] = [];
  const spawn: Spawn = async (id, options) => {
    started.push({ id, options });
    if (id === "key") queueMicrotask(() => options?.onStdout?.(saved.key));
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => undefined,
      exited: Promise.resolve(0),
    };
  };
  return { spawn, started };
}

it("starts every claude, the protected release included, with the saved key", async () => {
  const { spawn, started } = host({ key: `${KEY}\n` });
  const auth = new ClaudeAuth(spawn);
  const authorized = auth.authorize(spawn, true);
  for (const id of ["claude", "claude-protected-arm64"])
    await authorized(id, { args: ["--verbose"], env: { ...ENV, A: "1" } });
  await authorized("platform", { env: { ...ENV } });
  expect(started.map(({ id }) => id)).toEqual([
    "key",
    "claude",
    "claude-protected-arm64",
    "platform",
  ]);
  for (const { options } of started.slice(1, 3))
    expect(options).toEqual({
      args: ["--verbose"],
      env: { ...ENV, A: "1", ANTHROPIC_API_KEY: KEY },
    });
  // Other processes never see it.
  expect(started[3]?.options?.env).toHaveProperty("ANTHROPIC_API_KEY", null);
});

it("refuses a turn's claude without a key, but lets setup run its checks", async () => {
  const { spawn, started } = host({ key: "" });
  const auth = new ClaudeAuth(spawn);
  await expect(
    auth.authorize(spawn, true)("claude", { env: ENV }),
  ).rejects.toThrow("Claude needs an Anthropic API key.");
  expect(started.map(({ id }) => id)).toEqual(["key"]);
  await auth.authorize(spawn)("claude", { args: ["--version"], env: ENV });
  expect(started.at(-1)).toEqual({
    id: "claude",
    options: { args: ["--version"], env: ENV },
  });
});

it("reads the key again once it is saved or checked", async () => {
  const saved = { key: "" };
  const { spawn, started } = host(saved);
  const auth = new ClaudeAuth(spawn);
  await expect(auth.check()).resolves.toBeUndefined();
  saved.key = KEY;
  // Cached until then.
  await expect(auth.authorize(spawn, true)("claude")).rejects.toThrow();
  await expect(auth.check()).resolves.toEqual({});
  await auth.authorize(spawn, true)("claude");
  expect(started.filter(({ id }) => id === "key")).toHaveLength(2);
  await auth.save(KEY);
  await auth.authorize(spawn, true)("claude");
  expect(started.filter(({ id }) => id === "key")).toHaveLength(3);
});

import { expect, it, vi } from "vitest";
import type {
  HostProcess,
  HostProcessOptions,
} from "../../features/host/service";
import type { Spawn } from "./claude";
import { checkClaude, ClaudeSetup } from "./setup";

/** A spawn whose processes print `output[args]` and exit with its code. */
function scripted(
  output: Record<string, { stdout?: string; code?: number } | Error>,
) {
  const calls: { id: string; args: readonly string[] }[] = [];
  const spawn = async (id: string, options: HostProcessOptions = {}) => {
    const args = options.args ?? [];
    calls.push({ id, args });
    const result = output[`${id} ${args.join(" ")}`.trim()];
    if (result instanceof Error) throw result;
    queueMicrotask(() => {
      if (result?.stdout) options.onStdout?.(result.stdout);
    });
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => undefined,
      exited: new Promise<number | null>((resolve) =>
        setTimeout(() => resolve(result?.code ?? 0), 0),
      ),
    };
  };
  return { spawn, calls };
}

it("finds Claude missing when it cannot be started", async () => {
  const { spawn } = scripted({
    "claude --version": new Error("Could not start claude: No such file"),
  });
  await expect(checkClaude(spawn)).resolves.toEqual({ state: "missing" });
  const setup = new ClaudeSetup(spawn);
  await setup.check();
  expect(setup.providerSnapshot()).toEqual({
    readiness: "attention",
    attentionLabel: "Install Claude Code",
  });
});

it("reports the version and whether it is signed in", async () => {
  const signedOut = scripted({
    "claude --version": { stdout: "2.1.3 (Claude Code)\n" },
    "claude auth status --json": { stdout: '{"loggedIn":false}', code: 1 },
  });
  await expect(checkClaude(signedOut.spawn)).resolves.toEqual({
    state: "signed-out",
    version: "2.1.3",
  });
  const ready = scripted({
    "claude --version": { stdout: "2.1.3 (Claude Code)\n" },
    "claude auth status --json": {
      stdout: '{"loggedIn":true,"email":"a@example.com","orgName":"Example"}',
    },
  });
  await expect(checkClaude(ready.spawn)).resolves.toEqual({
    state: "ready",
    version: "2.1.3",
    account: "a@example.com · Example",
  });
  const setup = new ClaudeSetup(ready.spawn);
  await setup.check();
  const refreshing = setup.check();
  expect(setup.providerSnapshot()).toEqual({ readiness: "ready" });
  await refreshing;
});

it("runs sign-in, shows its output, and checks again after", async () => {
  const { spawn, calls } = scripted({
    "claude auth login": { stdout: "Opening browser…\n" },
    "claude --version": { stdout: "2.1.3\n" },
    "claude auth status --json": { stdout: '{"loggedIn":true}' },
  });
  const setup = new ClaudeSetup(spawn);
  const run = setup.run("login");
  expect(setup.snapshot().running).toBe("login");
  await run;
  expect(setup.snapshot()).toMatchObject({
    running: undefined,
    output: "Opening browser…\n",
    status: { state: "ready", version: "2.1.3" },
  });
  expect(calls.map((call) => call.args.join(" "))).toEqual([
    "auth login",
    "--version",
    "auth status --json",
  ]);
});

it("stops a step cancelled before its process was returned", async () => {
  const { spawn: check } = scripted({});
  let resolveSpawn!: (process: HostProcess) => void;
  let resolveExit!: (code: number | null) => void;
  const process: HostProcess & { killed?: boolean } = {
    write: async () => undefined,
    end: async () => undefined,
    kill: async () => {
      process.killed = true;
      resolveExit(null);
    },
    exited: new Promise((resolve) => {
      resolveExit = resolve;
    }),
  };
  const setup = new ClaudeSetup((id, options) =>
    id === "install"
      ? new Promise((resolve) => {
          resolveSpawn = resolve;
        })
      : check(id, options),
  );
  const run = setup.run("install");
  expect(setup.snapshot().running).toBe("install");
  await setup.cancel();
  resolveSpawn(process);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(process.killed).toBe(true);
  await run;
  expect(setup.snapshot()).toMatchObject({
    running: undefined,
    output: "\nInstall ended (stopped).",
  });
});

it("explains that it needs the desktop app", async () => {
  const setup = new ClaudeSetup(undefined);
  await setup.check();
  expect(setup.snapshot().status).toEqual({
    state: "error",
    message: "Claude agents run only in the desktop app",
  });
  expect(setup.providerSnapshot()).toEqual({
    readiness: "attention",
    attentionLabel: "Claude Code needs attention",
  });
});

it("caches failed model discovery until retry and closes a late probe on disposal", async () => {
  const checks = scripted({
    "claude --version": { stdout: "2.1.3" },
    "claude auth status --json": { stdout: '{"loggedIn":true}' },
  });
  let release!: (process: HostProcess) => void;
  const late = new Promise<HostProcess>((resolve) => {
    release = resolve;
  });
  const spawn = vi.fn<Spawn>(checks.spawn);
  const setup = new ClaudeSetup(spawn);
  await setup.check();
  spawn.mockRejectedValueOnce(new Error("probe failed"));
  await setup.loadModels();
  expect(setup.snapshot().modelsError).toBe("probe failed");
  await setup.loadModels();
  expect(spawn).toHaveBeenCalledTimes(3);
  spawn.mockImplementationOnce(() => late);
  const pending = setup.loadModels(true);
  expect(setup.snapshot().modelsChecking).toBe(true);
  setup.dispose();
  const kill = vi.fn(async () => undefined);
  release({
    write: async () => undefined,
    end: async () => undefined,
    kill,
    exited: Promise.resolve(null),
  });
  await pending;
  expect(kill).toHaveBeenCalled();
  expect(setup.snapshot().models).toEqual([]);
});

it("bounds a stalled discovery and releases it for an explicit retry", async () => {
  const checks = scripted({
    "claude --version": { stdout: "2.1.3" },
    "claude auth status --json": { stdout: '{"loggedIn":true}' },
  });
  let exit!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => {
    exit = resolve;
  });
  const kill = vi.fn(async () => {
    exit(null);
  });
  const spawn = vi.fn<Spawn>(checks.spawn);
  const setup = new ClaudeSetup(spawn);
  await setup.check();
  spawn.mockResolvedValueOnce({
    write: async () => undefined,
    end: async () => undefined,
    kill,
    exited,
  });
  vi.useFakeTimers();
  try {
    const pending = setup.loadModels();
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(kill).toHaveBeenCalled();
    expect(setup.snapshot().modelsChecking).toBe(false);
    expect(setup.snapshot().modelsError).toBe(
      "Claude Code model discovery timed out",
    );
    spawn.mockRejectedValueOnce(new Error("retry reached the process"));
    await setup.loadModels(true);
    expect(setup.snapshot().modelsError).toBe("retry reached the process");
  } finally {
    setup.dispose();
    vi.useRealTimers();
  }
});

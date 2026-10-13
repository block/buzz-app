// Claude on this computer: Buzz's own copy, whether it is signed in, and
// keeping that copy on the latest release. Each step runs as a declared
// process; the copy lives apart from any `claude` the user installed, and
// shares their `~/.claude` sign-in and settings.
import type {
  HostProcess,
  HostRequest,
  HostResponse,
} from "../../features/host/service";
import { ClaudeProcess, ENV, type Spawn } from "./claude";
import script from "./claude.sh?raw";

export type ClaudeStatus =
  | Readonly<{ state: "missing" }>
  /** Older than Buzz drives; Install updates it. */
  | Readonly<{ state: "outdated"; version: string }>
  | Readonly<{ state: "signed-out"; version: string }>
  | Readonly<{ state: "ready"; version: string; account?: string }>
  | Readonly<{ state: "error"; message: string }>;

const CHECK_TIMEOUT_MS = 15_000;
export type Request = (input: HostRequest) => Promise<HostResponse>;

/** Where Anthropic publishes each release with its checksums. */
const RELEASES = "https://downloads.claude.ai/claude-code-releases";
/** The oldest release Buzz drives: MCP servers marked `alwaysLoad`, which the
 * Buzz tools are, arrived in 2.1.121. */
export const MIN_VERSION = "2.1.121";
/** `uname -sm` to the release's platform name. */
const PLATFORMS: Readonly<Record<string, string>> = {
  "Darwin arm64": "darwin-arm64",
  "Darwin x86_64": "darwin-x64",
  "Linux aarch64": "linux-arm64",
  "Linux x86_64": "linux-x64",
};

/** The `claude.sh` step behind each process the plugin starts by name. */
const STEPS: Readonly<Record<string, string>> = {
  claude: "run",
  install: "install",
  use: "use",
};
/** Starts `claude`, `install` and `use` as steps of `claude.sh`, which the
 * manifest grants as `bash -c`; other processes start as declared. */
export const withScript =
  (spawn: Spawn): Spawn =>
  (id, options) => {
    const step = STEPS[id];
    return step
      ? spawn("claude-sh", {
          ...options,
          args: [script, "claude.sh", step, ...(options?.args ?? [])],
        })
      : spawn(id, options);
  };

/** Orders `a.b.c` versions; negative when `a` is older. */
export function compareVersions(a: string, b: string) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/** Runs a short process and returns its exit code and output. */
async function collect(spawn: Spawn, id: string, args: readonly string[]) {
  let stdout = "";
  let stderr = "";
  const process = await spawn(id, {
    args,
    env: ENV,
    onStdout: (data) => {
      stdout += data;
    },
    onStderr: (data) => {
      stderr += data;
    },
  });
  const timer = setTimeout(() => void process.kill(), CHECK_TIMEOUT_MS);
  const code = await process.exited;
  clearTimeout(timer);
  return { code, stdout, stderr };
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function checkClaude(spawn: Spawn): Promise<ClaudeStatus> {
  let version: string;
  try {
    const result = await collect(spawn, "claude", ["--version"]);
    // The launcher's answer when Buzz has no copy yet.
    if (result.code === 127) return { state: "missing" };
    if (result.code !== 0)
      return {
        state: "error",
        message: result.stderr.trim() || "Claude did not start",
      };
    version = result.stdout.trim().split(/\s/)[0] ?? "";
  } catch (error) {
    return { state: "error", message: message(error) };
  }
  if (compareVersions(version, MIN_VERSION) < 0)
    return { state: "outdated", version };
  try {
    const { stdout } = await collect(spawn, "claude", [
      "auth",
      "status",
      "--json",
    ]);
    const status = JSON.parse(stdout) as {
      loggedIn?: boolean;
      email?: string;
      orgName?: string;
    };
    if (!status.loggedIn) return { state: "signed-out", version };
    const account = [status.email, status.orgName].filter(Boolean).join(" · ");
    return { state: "ready", version, ...(account ? { account } : {}) };
  } catch {
    return { state: "signed-out", version };
  }
}

/** Runs `claude` as the given release rather than the one in use. */
const pinned =
  (spawn: Spawn, version: string): Spawn =>
  (id, options) =>
    spawn(id, {
      ...options,
      env: { ...options?.env, BUZZ_CLAUDE_VERSION: version },
    });

/** A downloaded release must start and answer the protocol Buzz drives it
 * with, listing its models without a turn, before any session uses it. */
async function testRelease(spawn: Spawn, version: string) {
  const release = pinned(spawn, version);
  const { code, stdout, stderr } = await collect(release, "claude", [
    "--version",
  ]);
  if (code !== 0 || !stdout.startsWith(version))
    throw new Error(stderr.trim() || "it did not report its version");
  const claude = await ClaudeProcess.start(release, {
    cwd: "~",
    systemPrompt: "",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const models = await Promise.race([
      claude.models(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("it did not list its models")),
          CHECK_TIMEOUT_MS,
        );
      }),
    ]);
    if (!models.length) throw new Error("it did not list its models");
  } finally {
    clearTimeout(timer);
    void claude.kill();
  }
}

export type SetupState = Readonly<{
  status: ClaudeStatus | undefined;
  checking: boolean;
  running: "install" | "login" | undefined;
  /** The running or last step's output. */
  output: string;
  /** Why the latest release is not the one in use, after it failed its test. */
  notice: string | undefined;
}>;
const OUTPUT_LIMIT = 20_000;

/** The plugin's one view of Claude on this computer. */
export class ClaudeSetup {
  private state: SetupState = {
    status: undefined,
    checking: false,
    running: undefined,
    output: "",
    notice: undefined,
  };
  private readonly listeners = new Set<() => void>();
  private process: HostProcess | undefined;
  /** Cancel was asked for before the running step's process was returned. */
  private cancelled = false;
  /** Releases that failed their test, not downloaded again until restart. */
  private readonly refused = new Set<string>();

  constructor(
    private readonly spawn: Spawn | undefined,
    private readonly request?: Request,
  ) {}

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(change: Partial<SetupState>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
  private log(text: string) {
    this.set({ output: (this.state.output + text).slice(-OUTPUT_LIMIT) });
  }

  async check() {
    if (!this.spawn) {
      this.set({
        status: {
          state: "error",
          message: "Claude agents run only in the desktop app",
        },
      });
      return;
    }
    if (this.state.checking) return;
    this.set({ checking: true });
    const status = await checkClaude(this.spawn);
    this.set({ status, checking: false });
  }

  /** Moves Buzz's copy to the latest release. Unless `needed`, a computer
   * without a copy is left without one: the download is large. */
  async update(needed: boolean) {
    if (!this.spawn || this.state.running) return;
    if (!needed && (await checkClaude(this.spawn)).state === "missing") return;
    await this.run("install", false);
  }

  /** Installs or updates Buzz's copy, or runs sign-in; then checks again.
   * Asked for by the person, it also retries a release that failed its test,
   * and shows only this step's output. */
  async run(step: "install" | "login", asked = true) {
    if (!this.spawn || this.state.running) return;
    this.cancelled = false;
    if (asked) this.refused.clear();
    this.set({ running: step, ...(asked ? { output: "" } : {}) });
    try {
      if (step === "install") await this.install(this.spawn);
      else await this.step(this.spawn, "claude", ["auth", "login"], "Sign-in");
    } catch (error) {
      this.log(`\n${message(error)}`);
    } finally {
      this.process = undefined;
      this.set({ running: undefined });
    }
    await this.check();
  }

  /** Runs one process with its output shown; throws unless it succeeds. */
  private async step(
    spawn: Spawn,
    id: string,
    args: readonly string[],
    label: string,
  ) {
    if (this.cancelled) throw new Error(`${label} ended (stopped).`);
    this.process = await spawn(id, {
      args,
      env: ENV,
      onStdout: (text) => this.log(text),
      onStderr: (text) => this.log(text),
    });
    if (this.cancelled) void this.process.kill();
    const code = await this.process.exited;
    this.process = undefined;
    if (code !== 0) throw new Error(`${label} ended (${code ?? "stopped"}).`);
  }

  private async fetch(path: string) {
    if (!this.request) throw new Error("Claude downloads need the desktop app");
    const response = await this.request({ url: `${RELEASES}/${path}` });
    if (response.status !== 200)
      throw new Error(`downloads.claude.ai answered ${response.status}`);
    return response.body;
  }

  /** Downloads the latest release, checks it against its published checksum,
   * tests it, and only then makes it the one new sessions start. */
  private async install(spawn: Spawn) {
    const status = await checkClaude(spawn);
    const current = "version" in status ? status.version : undefined;
    const latest = (await this.fetch("latest")).trim();
    if (!/^\d+\.\d+\.\d+$/.test(latest))
      throw new Error("downloads.claude.ai did not name a release");
    if (latest === current || this.refused.has(latest) || this.cancelled)
      return;
    if (compareVersions(latest, MIN_VERSION) < 0)
      throw new Error(
        `Claude ${latest} is older than Buzz needs (${MIN_VERSION}).`,
      );
    const platform =
      PLATFORMS[(await collect(spawn, "platform", [])).stdout.trim()];
    if (!platform) throw new Error("Claude is not available for this computer");
    const manifest = JSON.parse(
      await this.fetch(`${latest}/manifest.json`),
    ) as {
      platforms?: Record<string, { checksum?: unknown } | undefined>;
    };
    const checksum = manifest.platforms?.[platform]?.checksum;
    if (typeof checksum !== "string" || !/^[0-9a-f]{64}$/.test(checksum))
      throw new Error(`Claude ${latest} lists no checksum for ${platform}`);
    this.log(`Downloading Claude ${latest}…\n`);
    await this.step(spawn, "install", [latest, platform, checksum], "Download");
    this.log(`Testing Claude ${latest}…\n`);
    try {
      await testRelease(spawn, latest);
    } catch (error) {
      this.refused.add(latest);
      const reason = `Claude ${latest} failed its test: ${message(error)}`;
      this.set({
        notice: current ? `${reason}. Buzz keeps using ${current}.` : reason,
      });
      throw new Error(reason);
    }
    await this.step(spawn, "use", [latest], "Switching");
    this.set({ notice: undefined });
    this.log(`Claude ${latest} is installed.\n`);
  }

  /** Sends a line to the running step, such as a sign-in code. */
  answer(text: string) {
    return this.process?.write(`${text}\n`);
  }
  cancel() {
    this.cancelled = true;
    return this.process?.kill();
  }
  dispose() {
    void this.cancel();
  }
}

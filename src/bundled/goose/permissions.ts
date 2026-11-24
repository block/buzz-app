// goose checks its saved per-tool permissions before it asks Buzz, so a tool
// the owner always allowed would skip the agent's tool role. Each agent's
// goose runs in its own root that links every entry of the owner's goose
// config and data except `permission.yaml`. Buzz then decides every tool call
// itself: the owner's saved denials and approvals, read as they are now, and
// the agent's current role must both allow it.
import { parse } from "yaml";
import { REQUEST_TIMEOUT_MS } from "../../features/agent-harness/acp/process";
import type { Spawn } from "./goose";

export type GooseRoot = Readonly<{
  /** The `GOOSE_PATH_ROOT` the agent's goose runs in. */
  root: string;
  /** The owner's own permission file, which Buzz only reads. */
  permissions: string;
}>;

export const UNENFORCEABLE =
  "Buzz can't keep goose's saved tool permissions from overriding this agent's Tools role on this computer, so it won't run goose with a restricted role here.";

/** Prepares the agent's root, refreshing its links to the owner's goose. */
export async function prepareRoot(
  spawn: Spawn,
  agent: string,
): Promise<GooseRoot> {
  let stdout = "";
  let stderr = "";
  const process = await spawn("goose-root", {
    args: [agent.replace(/[^0-9A-Za-z_-]/g, "_")],
    onStdout: (data) => {
      stdout += data;
    },
    onStderr: (data) => {
      stderr += data;
    },
  });
  const timer = setTimeout(() => void process.kill(), REQUEST_TIMEOUT_MS);
  const code = await process.exited.finally(() => clearTimeout(timer));
  const [root, permissions] = stdout.split("\n");
  if (code !== 0 || !root || !permissions)
    throw new Error(stderr.trim() || "goose's root couldn't be prepared");
  return { root, permissions };
}

type Saved = Readonly<{ ask_before?: unknown; never_allow?: unknown }>;
const names = (value: unknown) =>
  Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];

/** Whether the owner's saved goose permissions let `tool` run without a
 * person approving it. A file that is missing saves none; one that can't be
 * read or parsed allows nothing. */
export async function ownerAllows(
  read: (path: string) => Promise<Uint8Array>,
  permissions: string,
  tool: string,
) {
  let text: string;
  try {
    text = new TextDecoder().decode(await read(permissions));
  } catch (error) {
    return /no such file|not found|cannot find/i.test(String(error));
  }
  try {
    const user = (parse(text) as { user?: Saved } | null)?.user;
    // Buzz has no one to ask, so a tool that needs approval is refused.
    return ![...names(user?.never_allow), ...names(user?.ask_before)].includes(
      tool,
    );
  } catch {
    return false;
  }
}

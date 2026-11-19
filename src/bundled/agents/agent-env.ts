import { invoke, isTauri } from "@tauri-apps/api/core";
import { pubkeyOf, type AgentKey } from "../../features/agents/membership";

/** Whether the local agent has environment variables of its own, read fresh
 * from native; `undefined` when that can't be read. Only presence is known
 * here: values stay native. Without native (tests, browsers) there is none. */
export async function hasOwnEnv(agent: AgentKey): Promise<boolean | undefined> {
  if (!isTauri()) return false;
  try {
    const status = await invoke<{ names: string[] } | null>(
      "agent_env_status",
      { agent: pubkeyOf(agent) },
    );
    return !!status?.names.length;
  } catch {
    return undefined;
  }
}

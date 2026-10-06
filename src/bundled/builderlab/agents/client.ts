import type { Host, HostResponse } from "../../../features/host/service";
import { oauthTarget } from "../oauth/browser";
import type { OAuthSession } from "../oauth/session";

export type RemoteAgent = Readonly<{
  id: string;
  name: string;
  pubkey: string;
  status: "Active" | "Unattested" | "Revoked" | "Unknown";
}>;

function resultStatus(value: unknown) {
  return typeof value === "string"
    ? (value.split("_").at(-1) ?? "")
    : typeof value === "number"
      ? value
      : "";
}

function agentStatus(value: unknown): RemoteAgent["status"] {
  const status = String(value ?? "")
    .split("_")
    .at(-1);
  if (status === "2" || status === "ACTIVE") return "Active";
  if (status === "1" || status === "UNATTESTED") return "Unattested";
  if (status === "3" || status === "REVOKED") return "Revoked";
  return "Unknown";
}

export function createAgentClient(host: Host, session: OAuthSession) {
  async function request(path: string, body: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    const credential = session.credential();
    const check = () => {
      signal.throwIfAborted();
      if (
        session.snapshot().status !== "signed-in" ||
        session.credential() !== credential
      )
        throw new DOMException("Builderlab session changed.", "AbortError");
    };
    let response: HostResponse;
    try {
      response = await host.request({
        url: `${oauthTarget()}/v3/beekeeper/${path}`,
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-BB-Session-Credential": credential.value,
        },
        body: JSON.stringify(body),
      });
    } catch {
      check();
      throw new Error("Could not reach Builderlab. Try again.");
    }
    check();
    if (response.status === 401) {
      session.signOut();
      throw new Error("Your Builderlab session expired. Sign in again.");
    }
    if (response.status === 403)
      throw new Error("This Builderlab account cannot manage remote agents.");
    if (response.status < 200 || response.status >= 300)
      throw new Error(`Builderlab request failed (HTTP ${response.status}).`);
    try {
      const result = JSON.parse(response.body);
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw new Error();
      return result;
    } catch {
      throw new Error("Builderlab returned an invalid response.");
    }
  }
  return {
    async list(signal: AbortSignal): Promise<readonly RemoteAgent[]> {
      const result = await request("list-agents", {}, signal);
      if (![1, "SUCCESS"].includes(resultStatus(result.status)))
        throw new Error("Builderlab did not return an agent list.");
      // Protobuf JSON can omit an empty repeated field.
      const agents = result.agents ?? [];
      if (
        !Array.isArray(agents) ||
        agents.some(
          (row) =>
            !row ||
            typeof row.agent_id !== "string" ||
            !row.agent_id.trim() ||
            typeof row.agent_name !== "string" ||
            typeof row.agent_pubkey !== "string" ||
            !/^[0-9a-f]{64}$/.test(row.agent_pubkey),
        )
      )
        throw new Error("Builderlab returned an invalid agent list.");
      return agents.map((row) => ({
        id: row.agent_id,
        name: row.agent_name,
        pubkey: row.agent_pubkey,
        status: agentStatus(row.status),
      }));
    },
  };
}
export type AgentClient = ReturnType<typeof createAgentClient>;

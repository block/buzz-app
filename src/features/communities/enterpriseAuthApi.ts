import { invoke } from "@tauri-apps/api/core";
import { communityDestination } from "./destination";

export type EnterpriseAuth = { expiresAt: string };

export type EnterpriseAuthClient = {
  gate(community: string): Promise<boolean>;
  get(): Promise<EnterpriseAuth | null>;
  start(attemptId: string): Promise<EnterpriseAuth>;
  cancel(attemptId: string): Promise<void>;
  clear(): Promise<void>;
};

function authInfo(value: unknown): EnterpriseAuth {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as { expiresAt?: unknown }).expiresAt !== "string"
  )
    throw new Error("Enterprise authentication returned an invalid status");
  return { expiresAt: (value as { expiresAt: string }).expiresAt };
}

export function createEnterpriseAuthClient(): EnterpriseAuthClient {
  return {
    async gate(community) {
      const relayUrl = communityDestination(community).url;
      const result = await invoke<{ status?: unknown }>(
        "enterprise_login_gate",
        { relayUrl },
      );
      if (result?.status === "notRequired") return false;
      if (result?.status === "required") return true;
      throw new Error(
        "Enterprise identity discovery returned an invalid status",
      );
    },
    async get() {
      const result = await invoke<unknown>("get_enterprise_auth");
      return result === null ? null : authInfo(result);
    },
    async start(attemptId) {
      return authInfo(
        await invoke<unknown>("start_enterprise_auth_login", { attemptId }),
      );
    },
    async cancel(attemptId) {
      await invoke("cancel_enterprise_auth_login", { attemptId });
    },
    async clear() {
      await invoke("clear_enterprise_auth");
    },
  };
}

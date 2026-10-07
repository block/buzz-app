import { invoke, isTauri } from "@tauri-apps/api/core";
import { Service, type Context } from "@deepseek-ai/cordis";
import type {} from "../../plugins/api";
import { nativeIdentityEnabled } from "../identity/service";

export type HostRequest = Readonly<{
  url: string;
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Readonly<Record<string, string>>;
  body?: string;
  /** A saved secret the native client adds as a header; JavaScript never sees its value. */
  secret?: HostSecretReference;
}>;
/**
 * Names a saved secret. It is sent only to origins declared by the plugin that
 * saved it (`provider`, this plugin when omitted). Another plugin's secret is
 * used only after the user chooses Always Allow in a native dialog.
 */
export type HostSecretReference = Readonly<{
  provider?: string;
  name: string;
  header: string;
  prefix?: string;
}>;
/** This plugin's own saved secrets. Values can be saved and used, never read. */
export interface HostSecrets {
  has(name: string): Promise<boolean>;
  /** Opens an app-owned window where the user enters the value; resolves whether it was saved. */
  enter(name: string, label: string): Promise<boolean>;
  delete(name: string): Promise<void>;
}
export type HostResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}>;
/** Reusable NIP-OA proof for one agent key; preparing it does not submit it. */
export type NipOaAuthorization = readonly [
  "auth",
  ownerPubkey: string,
  conditions: string,
  signature: string,
];
export interface Host {
  runCommand(id: string): Promise<string | null>;
  request(input: HostRequest): Promise<HostResponse>;
  readonly secrets: HostSecrets;
  prepareRemoteAgentAuthorization?: (
    agentPubkey: string,
    signal?: AbortSignal,
  ) => Promise<NipOaAuthorization>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    host: Host;
  }
}

export class HostService extends Service implements Host {
  constructor(context: Context) {
    super(context, "host");
  }

  async prepareRemoteAgentAuthorization(
    agentPubkey: string,
    signal?: AbortSignal,
  ): Promise<NipOaAuthorization> {
    signal?.throwIfAborted();
    if (!/^[0-9a-f]{64}$/.test(agentPubkey))
      throw new Error("Agent pubkey must be 64 lowercase hex characters");
    const native = nativeIdentityEnabled();
    const owner = native
      ? await invoke<string | null>("identity_restore")
      : (
          await (
            await fetch("/api/relay/identity", { signal: signal ?? null })
          ).json()
        ).viewer;
    signal?.throwIfAborted();
    if (typeof owner !== "string" || !/^[0-9a-f]{64}$/.test(owner))
      throw new Error("Set up your identity first");
    if (owner === agentPubkey)
      throw new Error("Owner and agent pubkeys must differ");
    let tag: NipOaAuthorization;
    if (native) {
      try {
        tag = await invoke<NipOaAuthorization>(
          "identity_prepare_remote_agent_authorization",
          { owner, agentPubkey },
        );
      } catch (error) {
        throw typeof error === "string" ? new Error(error) : error;
      }
    } else {
      const response = await fetch(
        "/api/relay/prepare-remote-agent-authorization",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ owner, agentPubkey }),
          signal: signal ?? null,
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error ?? "Owner authorization failed");
      tag = result;
    }
    signal?.throwIfAborted();
    if (
      !Array.isArray(tag) ||
      tag.length !== 4 ||
      tag[0] !== "auth" ||
      tag[1] !== owner ||
      tag[2] !== "" ||
      typeof tag[3] !== "string" ||
      !/^[0-9a-f]{128}$/.test(tag[3])
    )
      throw new Error("Invalid remote agent authorization");
    return tag;
  }

  async runCommand(id: string): Promise<string | null> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri()) return null;
    try {
      return await invoke<string | null>("plugin_host_run_command", {
        id: owner.id,
        revision: owner.revision,
        commandId: id,
      });
    } catch {
      return null;
    }
  }

  // A getter, so `this.ctx` is the calling plugin's context, as in request().
  get secrets(): HostSecrets {
    return {
      has: (name) => this.secretCommand<boolean>("plugin_secret_has", { name }),
      enter: (name, label) =>
        this.secretCommand<boolean>("plugin_secret_enter", { name, label }),
      delete: (name) =>
        this.secretCommand<void>("plugin_secret_delete", { name }),
    };
  }

  private async secretCommand<T>(
    command: string,
    args: Record<string, string>,
  ): Promise<T> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new Error("Secrets require an installed desktop plugin");
    try {
      return await invoke<T>(command, {
        id: owner.id,
        revision: owner.revision,
        ...args,
      });
    } catch (error) {
      throw typeof error === "string" ? new Error(error) : error;
    }
  }

  async request(input: HostRequest): Promise<HostResponse> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new Error("Host requests require an installed desktop plugin");
    return invoke<HostResponse>("plugin_host_request", {
      id: owner.id,
      revision: owner.revision,
      request: input,
    });
  }
}

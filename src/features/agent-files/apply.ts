// Reads a local agent as an agent document, and applies one, for the
// credential provider's `agent_read` and `agent_apply`. Only the owner's own
// paired tools reach this; native code refuses an agent's token.
import type { Agent, Agents } from "../agents/service";
import type { SettingsSchema } from "../agents/agent-config";
import { administerMember } from "../channel-members/administration";
import { memberAuthority } from "../channel-members/administration-protocol";
import { exactLifecycleTag } from "../relay/channel-lifecycle-protocol";
import { channelIdentity } from "../relay/channel-labels";
import { soloLabels } from "../solo/labels";
import type { RelaySession } from "../relay/session";
import {
  documentOf,
  parseDocument,
  planApply,
  revisionOf,
  type AgentDocument,
  type ApplyPlan,
  type ChannelMembership,
} from "./document";

export type AgentFileHost = Readonly<{
  agents: Pick<Agents, "snapshot" | "save" | "create" | "types">;
  /** The open community's session, or nothing while it isn't connected. */
  relay():
    | Pick<
        RelaySession,
        "readRemote" | "relayAuthor" | "viewer" | "memberAdministration"
      >
    | undefined;
  /** Unix seconds. */
  now?: () => number;
}>;

/** A failure the CLI is told, with its provider error code. */
export class AgentCallError extends Error {
  constructor(
    readonly code: "conflict" | "invalid_request" | "unavailable" | "denied",
    message: string,
  ) {
    super(message);
  }
}

const HEX = /^[0-9a-f]{64}$/;
const ROSTER_LIMIT = 500;

/** The type's synced settings, and how they merge into its config. */
const typeOf = (host: AgentFileHost, type: string) =>
  host.agents.types().find((registered) => registered.key === type);
const schemaOf = (
  host: AgentFileHost,
  type: string,
): SettingsSchema | undefined => typeOf(host, type)?.syncedSettings?.schema;

/** One of the owner's agents that runs here, in the open community, by hex
 * key or exact name. */
function find(host: AgentFileHost, agent: string, community?: string) {
  const snapshot = host.agents.snapshot();
  if (snapshot.status !== "ready")
    throw new AgentCallError("unavailable", "Buzz is still loading agents");
  const here = snapshot.agents.filter((item) => item.place === "here");
  const matches = HEX.test(agent)
    ? here.filter((item) => item.pubkey === agent)
    : here.filter((item) => item.name === agent);
  if (matches.length > 1)
    throw new AgentCallError(
      "invalid_request",
      `More than one agent is named ${agent}; use its npub`,
    );
  const [found] = matches;
  if (!found) {
    const elsewhere = snapshot.agents.some(
      (item) => item.pubkey === agent || item.name === agent,
    );
    throw new AgentCallError(
      "invalid_request",
      elsewhere
        ? `${agent} doesn't run on this computer; import and export work only for agents that run here`
        : `No agent ${agent} in the community open in Buzz`,
    );
  }
  if (community && community !== found.relay)
    throw new AgentCallError(
      "unavailable",
      `Open ${community} in Buzz to change this agent`,
    );
  return found;
}

/** The channels the agent is in that the owner can see, with its role in
 * each: not DMs, Solo chats, system channels or archived ones. */
export async function channelsOf(
  host: AgentFileHost,
  pubkey: string,
): Promise<ChannelMembership[]> {
  const relay = host.relay();
  const relayAuthor = relay?.relayAuthor;
  if (!relay || !relayAuthor)
    throw new AgentCallError("unavailable", "Connect to the community first");
  const rosters = await relay.readRemote([
    {
      kinds: [39002],
      authors: [relayAuthor],
      "#p": [pubkey],
      limit: ROSTER_LIMIT,
    },
  ]);
  const ids = [
    ...new Set(
      rosters.flatMap((event) => {
        const id = exactLifecycleTag(event, "d");
        return id ? [id] : [];
      }),
    ),
  ];
  if (!ids.length) return [];
  const events = await relay.readRemote([
    {
      kinds: [39000, 39001, 39002],
      authors: [relayAuthor],
      "#d": ids,
      limit: ids.length * 3,
    },
  ]);
  const memberships: ChannelMembership[] = [];
  for (const id of ids) {
    const own = events.filter((event) => exactLifecycleTag(event, "d") === id);
    const metadata = own.find((event) => event.kind === 39000);
    if (!metadata) continue;
    const { type, labels } = channelIdentity(metadata);
    if (type !== "stream" && type !== "forum") continue;
    if (soloLabels(labels)) continue;
    if (exactLifecycleTag(metadata, "archived") === "true") continue;
    const role = memberAuthority(own, id, relay.viewer ?? "", relayAuthor)
      .roles[pubkey];
    if (role) memberships.push({ channel: id, role });
  }
  return memberships;
}

async function read(host: AgentFileHost, agent: Agent) {
  const document = documentOf(
    agent,
    schemaOf(host, agent.type),
    await channelsOf(host, agent.pubkey),
  );
  return { document, revision: await revisionOf(document) };
}

/** `agent_read`: `[agent]`, a hex key or exact name. */
export async function readAgentDocument(
  host: AgentFileHost,
  params: readonly string[],
) {
  const [agent = ""] = params;
  const { document, revision } = await read(host, find(host, agent));
  return JSON.stringify({ revision, document });
}

/** A checked `agent_apply` waiting for the owner's approval. */
export type PendingApply = Readonly<{
  /** The agent's name as it is now, or the new agent's. */
  name: string;
  creating: boolean;
  plan: ApplyPlan;
  /** Applies the change; resolves with the CLI's result. */
  run(): Promise<string>;
}>;

/** Checks `agent_apply`: `[agent or "", document, revision or "", options]`.
 * Resolves with nothing to ask when the agent already matches. */
export async function prepareApply(
  host: AgentFileHost,
  params: readonly string[],
): Promise<PendingApply | string> {
  const [target = "", json = "", revision = "", optionsJson = "{}"] = params;
  let desired: AgentDocument;
  let options: { prune_channels?: unknown; workspace?: unknown };
  try {
    desired = parseDocument(json);
    options = JSON.parse(optionsJson) as typeof options;
  } catch (error) {
    throw new AgentCallError(
      "invalid_request",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (options.workspace != null)
    throw new AgentCallError(
      "invalid_request",
      "Buzz can't set an agent's workspace from an import yet; leave out --workspace and choose it in Buzz",
    );
  const prune = options.prune_channels === true;
  const now = Math.floor((host.now?.() ?? Date.now() / 1000) as number);
  const plan = (live: Parameters<typeof planApply>[0]) => {
    try {
      return planApply(live, desired, schemaOf(host, desired.type), now, prune);
    } catch (error) {
      throw new AgentCallError(
        "invalid_request",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  if (!target) {
    if (!typeOf(host, desired.type))
      throw new AgentCallError(
        "invalid_request",
        `Agents of type ${desired.type} aren't available in this Buzz`,
      );
    return {
      name: desired.profile.name,
      creating: true,
      plan: plan(undefined),
      run: () => create(host, desired, now, prune),
    };
  }
  if (desired.agent && desired.agent.pubkey !== target)
    throw new AgentCallError(
      "invalid_request",
      "The document is for another agent",
    );
  const agent = find(host, target, desired.agent?.community);
  const live = await read(host, agent);
  if (revision && revision !== live.revision)
    throw new AgentCallError(
      "conflict",
      `${agent.name} changed after it was read; run the command again`,
    );
  const planned = plan({ agent, document: live.document });
  const result = async () =>
    JSON.stringify({
      agent: agent.pubkey,
      revision: await revisionNow(host, agent.pubkey),
      changes: planned.changes,
    });
  if (!planned.changes.length) return result();
  return {
    name: agent.name,
    creating: false,
    plan: planned,
    run: async () => {
      // Read again: it may have changed while the owner looked.
      const now = await read(host, find(host, agent.pubkey));
      if (now.revision !== live.revision)
        throw new AgentCallError(
          "conflict",
          `${agent.name} changed while waiting for approval; run the command again`,
        );
      await apply(host, agent, planned);
      return result();
    },
  };
}

/** Its revision now, or nothing while the app doesn't list it yet. */
async function revisionNow(host: AgentFileHost, pubkey: string) {
  try {
    return (await read(host, find(host, pubkey))).revision;
  } catch {
    return "";
  }
}

/** Saves `plan` to `agent`, channels last. */
async function apply(host: AgentFileHost, agent: Agent, plan: ApplyPlan) {
  let config: unknown;
  if (plan.config) {
    const synced = typeOf(host, agent.type)?.syncedSettings;
    const merged =
      synced && agent.config && typeof agent.config === "object"
        ? synced.withSynced(agent.config, plan.config.settings)
        : agent.config;
    config = {
      ...(merged as object),
      instructions: plan.config.instructions,
    };
  }
  const attention = Object.keys(plan.attention).length
    ? plan.attention
    : undefined;
  await host.agents.save(agent.key, {
    ...plan.profile,
    ...(config !== undefined ? { config } : {}),
    ...(attention ? { attention, attentionExpected: plan.expected } : {}),
  });
  await applyChannels(host, agent.pubkey, plan.channels);
}

async function applyChannels(
  host: AgentFileHost,
  pubkey: string,
  channels: ApplyPlan["channels"],
) {
  const all = [...channels.add, ...channels.role];
  if (!all.length && !channels.remove.length) return;
  const relay = host.relay();
  if (!relay)
    throw new AgentCallError(
      "unavailable",
      "Saved the agent, but its channels can't change until Buzz reconnects. Run the import again.",
    );
  const failed: string[] = [];
  const run = async (
    channel: string,
    role: ChannelMembership["role"] | "remove",
  ) => {
    const result = await administerMember(
      relay.memberAdministration,
      channel,
      pubkey,
      (current) =>
        role === "remove"
          ? current
            ? { expectedRole: current, role: "remove" }
            : undefined
          : current === role
            ? undefined
            : {
                expectedRole: current ?? "absent",
                role: role as "admin" | "member" | "guest",
              },
    );
    if (result.status !== "confirmed")
      failed.push(`${channel}: ${result.error ?? "not confirmed"}`);
  };
  for (const { channel, role } of all) await run(channel, role);
  for (const channel of channels.remove) await run(channel, "remove");
  if (failed.length)
    throw new AgentCallError(
      "unavailable",
      `Saved the agent, but these channel changes didn't go through: ${failed.join("; ")}. Run the import again.`,
    );
}

async function create(
  host: AgentFileHost,
  desired: AgentDocument,
  now: number,
  prune: boolean,
) {
  const type = typeOf(host, desired.type);
  if (!type)
    throw new AgentCallError(
      "invalid_request",
      `Agents of type ${desired.type} aren't available in this Buzz`,
    );
  const defaults = type.defaults().config;
  const synced =
    type.syncedSettings && defaults && typeof defaults === "object"
      ? type.syncedSettings.withSynced(defaults, desired.settings)
      : defaults;
  const agent = await host.agents.create({
    type: desired.type,
    name: desired.profile.name,
    ...(desired.profile.picture ? { picture: desired.profile.picture } : {}),
    config: { ...(synced as object), instructions: desired.instructions },
  });
  // The rest, planned from the agent as it was made: its type may have given
  // it attention the document doesn't have.
  const document = documentOf(agent, type.syncedSettings?.schema, []);
  const rest = planApply(
    { agent, document },
    desired,
    type.syncedSettings?.schema,
    now,
    prune,
  );
  await apply(host, agent, rest);
  return JSON.stringify({
    agent: agent.pubkey,
    revision: await revisionNow(host, agent.pubkey),
    changes: ["created"],
  });
}

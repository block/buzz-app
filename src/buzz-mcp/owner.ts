// The owner tools (`owner_*`): read with the signed-in human's access instead
// of the agent's, only where the host gives the client `ownerAccess`. The host
// decides who the owner, agent and community are; no argument names them.
import type { BuzzClient, OwnerAccess, OwnerExecution } from "./client";
import type { Tool } from "./tools";

const channel = {
  type: "string",
  description: "Channel ID, from owner_channel_list.",
} as const;
const limit = (max: number, fallback: number) =>
  ({
    type: "integer",
    description: `Default ${fallback}, max ${max}.`,
  }) as const;
const offset = {
  type: "integer",
  description: "Entries to skip, from a previous answer's next.",
} as const;
const tool = (
  name: string,
  description: string,
  properties: Readonly<Record<string, object>>,
  required: readonly string[] = [],
): Tool => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
});

export const OWNER_TOOLS: readonly Tool[] = [
  tool(
    "owner_channel_list",
    "Your owner's channels in this community, read with their access, including ones you are not in and archived ones. partial means some may be missing.",
    { q: { type: "string" }, limit: limit(500, 100), offset },
  ),
  tool(
    "owner_channel_get",
    "One of your owner's channels, read with their access: its details, their role and what they may manage.",
    { channel },
    ["channel"],
  ),
  tool(
    "owner_member_list",
    "A channel's members and roles, read with your owner's access.",
    { channel, limit: limit(500, 100), offset },
    ["channel"],
  ),
];

export const isOwnerTool = (name: string) =>
  OWNER_TOOLS.some((tool) => tool.name === name);

/** Runs owner tool `name`. Throws, before reading anything, when this
 * client has no owner access, as a plugin's or another host's has not. */
export async function callOwnerTool(
  client: BuzzClient,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<Readonly<{ text: string; held(): void }>> {
  const tool = OWNER_TOOLS.find((tool) => tool.name === name);
  if (!tool) throw new Error(`No tool ${name}`);
  const { ownerAccess } = client;
  if (!ownerAccess)
    throw new Error(
      "Owner tools are not available to this agent here; nothing was read.",
    );
  const extra = Object.keys(args).filter(
    (arg) => !Object.hasOwn(tool.inputSchema.properties, arg),
  );
  if (extra.length)
    throw new Error(`${extra.join(", ")} cannot be used with ${name}.`);
  if (name === "owner_channel_list") {
    const page = paging(args);
    const q = optionalText(args.q, "q")?.toLowerCase();
    const list = await ownerAccess.channels();
    const matched = q
      ? list.channels.filter((item) => item.name.toLowerCase().includes(q))
      : list.channels;
    const shown = matched.slice(page.offset, page.offset + page.limit);
    const next = page.offset + shown.length;
    return answer(ownerAccess, list.execution, {
      channels: shown,
      total: matched.length,
      ...(next < matched.length ? { next: { offset: next } } : {}),
      partial: list.partial,
      ...(list.error ? { error: list.error } : {}),
    });
  }
  const id = optionalText(args.channel, "channel");
  if (!id) throw new Error("channel is required.");
  if (name === "owner_channel_get") {
    const { execution, ...details } = await ownerAccess.channel(id);
    return answer(ownerAccess, execution, details);
  }
  const page = paging(args);
  const { execution, ...members } = await ownerAccess.members(id, page);
  const next = page.offset + members.members.length;
  return answer(ownerAccess, execution, {
    ...members,
    ...(next < members.total ? { next: { offset: next } } : {}),
  });
}

/** The answer's text, and a check that the binding it was read with still
 * holds. */
function answer(
  ownerAccess: OwnerAccess,
  execution: OwnerExecution,
  fields: object,
) {
  return {
    text: JSON.stringify({ executedAs: execution, ...fields }),
    held: () => ownerAccess.held(execution),
  };
}

function paging(args: Readonly<Record<string, unknown>>) {
  const limit = args.limit ?? 100;
  const offset = args.offset ?? 0;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)
    throw new Error("limit must be a whole number, 1 or more.");
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)
    throw new Error("offset must be a whole number, 0 or more.");
  return { limit: Math.min(limit, 500), offset };
}

function optionalText(value: unknown, name: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be text.`);
  return value.trim() || undefined;
}

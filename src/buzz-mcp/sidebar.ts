import type { BuzzClient } from "./client";
import type { Tool } from "./tools";

export const SIDEBAR_TOOLS: readonly Tool[] = [
  {
    name: "section_list",
    description:
      "List your owner's sidebar sections and channel assignments in this community.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "channel_move",
    description:
      "Move a stream or DM your owner has joined into one of their sidebar sections. Use IDs; omit section to restore its default group. Removes its Star, as a manual move does. Changes no membership.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        section: {
          type: "string",
          description: "Section ID from section_list.",
        },
      },
      required: ["channel"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

export const isSidebarTool = (name: string) =>
  SIDEBAR_TOOLS.some((tool) => tool.name === name);

/** Dispatch through owner-bound host access; standalone clients have none. */
export async function callSidebarTool(
  client: BuzzClient,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<string> {
  const tool = SIDEBAR_TOOLS.find((tool) => tool.name === name);
  if (!tool) throw new Error(`No tool ${name}`);
  for (const key of Object.keys(args))
    if (!Object.hasOwn(tool.inputSchema.properties, key))
      throw new Error(`${key} cannot be used with ${name}.`);
  const { sidebar } = client;
  if (!sidebar)
    throw new Error("Sidebar sections are unavailable from this connection.");
  const signal = client.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  if (name === "section_list")
    return JSON.stringify(await sidebar.list(signal));
  for (const key of [
    "channel",
    ...(args.section !== undefined ? ["section"] : []),
  ])
    if (
      typeof args[key] !== "string" ||
      !args[key].trim() ||
      args[key].length > 256
    )
      throw new Error(
        `${key} must be a non-empty ID of at most 256 characters.`,
      );
  await sidebar.move(
    args.channel as string,
    args.section as string | undefined,
    signal,
  );
  return JSON.stringify({
    channel: args.channel,
    section: args.section ?? null,
  });
}

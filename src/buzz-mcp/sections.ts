// The sidebar section tools: the owner's sections in the agent's community,
// which an agent running on the owner's device can arrange for them.
import type { BuzzClient } from "./client";
import type { Tool } from "./tools";

const id = { type: "string", description: "A section id from sections_list." };
const name = { type: "string" };
const tool = (
  name: string,
  description: string,
  properties: Readonly<Record<string, object>>,
  required: readonly string[],
  annotations: Tool["annotations"],
): Tool => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  },
  ...(annotations ? { annotations } : {}),
});

export const SECTIONS_TOOLS: readonly Tool[] = [
  tool(
    "sections_list",
    "Your owner's sidebar sections, in order, with each one's channels, and their starred channels. Channels in neither are in Channels.",
    {},
    [],
    { readOnlyHint: true },
  ),
  tool(
    "section_create",
    "Create an empty sidebar section for your owner; gives its id.",
    { name },
    ["name"],
    { readOnlyHint: false, destructiveHint: false },
  ),
  tool(
    "section_rename",
    "Rename one of your owner's sidebar sections.",
    { id, name },
    ["id", "name"],
    { readOnlyHint: false, destructiveHint: false },
  ),
  tool(
    "section_remove",
    "Remove one of your owner's sidebar sections. Its channels move back to Channels; no channel is deleted.",
    { id },
    ["id"],
    { readOnlyHint: false, destructiveHint: true },
  ),
  tool(
    "section_assign",
    "Move a channel into one of your owner's sidebar sections, or without section back to Channels. A starred channel moved into a section is no longer starred.",
    {
      channel: { type: "string", description: "A channel id or exact name." },
      section: id,
    },
    ["channel"],
    { readOnlyHint: false, destructiveHint: false },
  ),
];

export const isSectionsTool = (name: string) =>
  SECTIONS_TOOLS.some((tool) => tool.name === name);

const text = (args: Readonly<Record<string, unknown>>, key: string) => {
  const value = args[key];
  if (typeof value !== "string" || !value)
    throw new Error(`${key} must be a non-empty string.`);
  return value;
};

/** Runs sections tool `name` as `client`. A throw is a tool error. */
export async function callSectionsTool(
  client: BuzzClient,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<string> {
  const tool = SECTIONS_TOOLS.find((tool) => tool.name === name);
  if (!tool) throw new Error(`No tool ${name}`);
  const extra = Object.keys(args).filter(
    (arg) => !Object.hasOwn(tool.inputSchema.properties, arg),
  );
  if (extra.length)
    throw new Error(`${extra.join(", ")} cannot be used with ${name}.`);
  const { sections } = client;
  if (!sections)
    throw new Error("Sidebar sections can't be changed from this connection.");
  switch (name) {
    case "sections_list":
      return JSON.stringify(await sections.list());
    case "section_create":
      return JSON.stringify(await sections.create(text(args, "name")));
    case "section_rename":
      await sections.rename(text(args, "id"), text(args, "name"));
      return "renamed";
    case "section_remove":
      await sections.remove(text(args, "id"));
      return "removed";
    default: {
      const section =
        args.section === undefined ? undefined : text(args, "section");
      await sections.assign(text(args, "channel"), section);
      return section ? "moved" : "moved to Channels";
    }
  }
}

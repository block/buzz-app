import type { BuzzClient } from "./client";
import { respond } from "./rpc";
import { TOOLS } from "./tools";

const fields: Readonly<Record<string, readonly string[]>> = {
  channel_list: ["q", "all", "types"],
  channel_get: ["channel"],
  read: [
    "channel",
    "thread",
    "q",
    "author",
    "since",
    "before",
    "before_id",
    "limit",
  ],
  send: ["channel", "text", "reply", "mentions", "audience"],
  reply_in_subthread: ["parent", "text", "mentions", "audience"],
};
const required: Readonly<Record<string, readonly string[]>> = {
  channel_get: ["channel"],
  send: ["channel", "text", "audience"],
  reply_in_subthread: ["parent", "text", "audience"],
};
const tools = TOOLS.filter((tool) => Object.hasOwn(fields, tool.name)).map(
  (tool) => ({
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: Object.fromEntries(
        Object.entries(tool.inputSchema.properties).filter(([name]) =>
          fields[tool.name]?.includes(name),
        ),
      ),
      ...(required[tool.name] ? { required: required[tool.name] } : {}),
      ...(tool.name === "read"
        ? { anyOf: [{ required: ["channel"] }, { required: ["thread"] }] }
        : {}),
    },
    annotations: {
      readOnlyHint: tool.name !== "send" && tool.name !== "reply_in_subthread",
    },
  }),
);

function validate(
  value: unknown,
  schema: {
    type?: string;
    enum?: readonly unknown[];
    items?: object;
    minItems?: number;
    uniqueItems?: boolean;
  },
  name: string,
) {
  const valid =
    schema.type === "array"
      ? Array.isArray(value)
      : schema.type === "integer"
        ? Number.isSafeInteger(value)
        : typeof value === schema.type;
  if (!valid || (schema.enum && !schema.enum.includes(value)))
    throw new Error(`Invalid ${name}.`);
  if (
    Array.isArray(value) &&
    ((schema.minItems !== undefined && value.length < schema.minItems) ||
      (schema.uniqueItems && new Set(value).size !== value.length))
  )
    throw new Error(`Invalid ${name}.`);
  if (Array.isArray(value) && schema.items)
    for (const item of value) validate(item, schema.items, name);
}

/** The external grant has no implicit conversation and cannot call plugin tools. */
export async function respondExternal(
  client: BuzzClient,
  input: unknown,
  connected: () => void,
) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Expected one JSON-RPC message.");
  const message = input as {
    id?: unknown;
    method?: string;
    params?: Record<string, unknown>;
  };
  const { id, method, params = {} } = message;
  if (id === undefined || id === null) return undefined;
  if (!params || typeof params !== "object" || Array.isArray(params))
    throw new Error("params must be an object.");
  const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });
  if (method === "initialize") {
    if (params.protocolVersion !== "2025-06-18")
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "Use MCP 2025-06-18." },
      };
    connected();
  }
  if (method === "tools/list") return result({ tools });
  if (method === "tools/call") {
    try {
      const tool = tools.find((tool) => tool.name === params.name);
      if (!tool)
        throw new Error(
          "This tool is not available through the external connection.",
        );
      const args = params.arguments ?? {};
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Error("arguments must be an object.");
      const values = args as Record<string, unknown>;
      for (const [name, value] of Object.entries(values)) {
        const schema = tool.inputSchema.properties[name];
        if (!schema)
          throw new Error(`${name} cannot be used with ${tool.name}.`);
        validate(value, schema, name);
      }
      for (const name of required[tool.name] ?? [])
        if (typeof values[name] !== "string" || !values[name].trim())
          throw new Error(`${name} is required.`);
      if (tool.name === "read" && !values.channel && !values.thread)
        throw new Error("channel or thread is required.");
      if (tool.name === "read" && values.q && !values.channel)
        throw new Error("channel is required with q.");
    } catch (error) {
      return result({
        isError: true,
        content: [{ type: "text", text: (error as Error).message }],
      });
    }
  }
  return respond(client, {}, input, [], {
    instructions:
      "Read and post text as the agent selected by the owner in Buzz. Supply explicit channel or message IDs. Use channel_list to find channels. Keys stay in Buzz. If this connection ends, ask the owner to create a new connection in Buzz Settings > Connect Nexus.",
  });
}

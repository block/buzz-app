import type { BuzzClient, Context } from "../../buzz-mcp/client";
import type { AddedTool } from "../../buzz-mcp/session-tools";

declare const operationBrand: unique symbol;
declare const proofBrand: unique symbol;

/** A provider's operation. Pass this descriptor to a consumer tool. */
export type AgentToolOperation = Readonly<{ [operationBrand]: true }>;
/** Proof for one checked operation and its exact arguments. */
export type AgentToolProof = Readonly<{ [proofBrand]: true }>;
export type AgentToolAuthority = Readonly<{
  client: BuzzClient;
  context: Context;
  signal: AbortSignal;
  viewer: string;
  community: string;
  /** Present only for this exact host-confirmed standalone instruction. */
  instruction?: Readonly<{ id: string; source: string }>;
  /** Call after awaited reads and in the synchronous admission callback. */
  check(): void;
}>;
export type AgentToolProvider = Readonly<{
  operation: AgentToolOperation;
  /** Claims a proof once. The returned check can be called more than once. */
  resolve(
    proof: AgentToolProof,
    args: Readonly<Record<string, unknown>>,
  ): AgentToolAuthority;
}>;

declare const instructionBrand: unique symbol;
/** Host-owned, turn-scoped authority; copying or serializing it grants nothing. */
export type AgentInstruction = Readonly<{ [instructionBrand]: true }>;
type InstructionBinding = Readonly<{
  operation: AgentToolOperation;
  args: string;
  agent: string;
  owner: string;
  community: string;
  id: string;
  source: string;
  tool: string;
  check(): void;
}>;
const instructions = new WeakMap<
  AgentInstruction,
  InstructionBinding & { claimed: boolean }
>();
export function instructionOperation(operation: AgentToolOperation) {
  const found = operations.get(operation);
  if (!found) throw new Error("No such registered agent operation");
  return found.name;
}
/** Called only after host confirmation, for one runner-owned turn. */
export function createInstruction(
  binding: InstructionBinding,
): AgentInstruction {
  const token = Object.freeze({}) as AgentInstruction;
  instructions.set(token, { ...binding, claimed: false });
  return token;
}
type NativeCall = Readonly<{
  signal: AbortSignal;
  instruction?: AgentInstruction;
  check(): void;
}>;
type Binding = Readonly<{
  viewer: string;
  community: string;
  check(): void;
  release(): void;
}>;
const clients = new WeakMap<BuzzClient, NativeCall>();
const operations = new WeakMap<
  AgentToolOperation,
  Readonly<{
    name: string;
    bind(
      client: BuzzClient,
      context: Context,
      tool: AddedTool,
      instruction?: AgentInstruction,
    ): Binding;
  }>
>();
const proofs = new WeakMap<
  AgentToolProof,
  {
    operation: AgentToolOperation;
    args: string;
    authority: AgentToolAuthority;
    claimed: boolean;
  }
>();

/** Only native runtime call sites register clients here. */
export function nativeToolClient(client: BuzzClient, call: NativeCall) {
  clients.set(client, call);
}

export function createToolOperation(
  name: string,
  bind: (
    client: BuzzClient,
    context: Context,
    tool: AddedTool,
    instruction?: AgentInstruction,
  ) => Binding,
): AgentToolProvider {
  const operation = Object.freeze({}) as AgentToolOperation;
  operations.set(operation, { name, bind });
  return Object.freeze({
    operation,
    resolve(proof: AgentToolProof, args: Readonly<Record<string, unknown>>) {
      const found = proofs.get(proof);
      if (
        !found ||
        found.operation !== operation ||
        found.claimed ||
        found.args !== exactArgs(args)
      )
        throw new Error("No matching agent operation proof");
      found.authority.check();
      found.claimed = true;
      return Object.freeze({
        ...found.authority,
        check: () => {
          found.authority.check();
          if (found.args !== exactArgs(args))
            throw new Error("Agent operation arguments changed");
        },
      });
    },
  });
}

/** JSON snapshot shared by the review and the eventual operation. */
export function instructionArgs(value: Readonly<Record<string, unknown>>) {
  if (
    !value ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("Instruction arguments must be a JSON object");
  const freeze = (item: unknown): unknown => {
    if (item && typeof item === "object") {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(JSON.parse(exactArgs(value))) as Readonly<
    Record<string, unknown>
  >;
}

/** JSON object order carries no meaning. Array order does. */
export function exactArgs(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(normalize);
    if (
      item &&
      typeof item === "object" &&
      Object.getPrototypeOf(item) === Object.prototype
    )
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, value]) => [key, normalize(value)]),
      );
    throw new Error("Agent operation arguments must be JSON values");
  };
  return JSON.stringify(normalize(value));
}

export async function callToolOperation(
  client: BuzzClient,
  context: Context,
  args: Record<string, unknown>,
  tool: AddedTool,
) {
  const operation = tool.operation;
  const registered = operation && operations.get(operation);
  const native = clients.get(client);
  if (!operation || !registered || !native)
    throw new Error("This operation requires an active native agent call");
  const input = exactArgs(args);
  context = Object.freeze(structuredClone(context));
  args = JSON.parse(input) as Record<string, unknown>;
  const requested = native.instruction && instructions.get(native.instruction);
  if (
    native.instruction &&
    (!requested ||
      requested.claimed ||
      requested.tool !== tool.name ||
      requested.operation !== operation ||
      requested.args !== input ||
      requested.agent !== client.key ||
      requested.owner !== client.owner ||
      context.channel !== undefined ||
      context.root !== undefined ||
      context.session !== undefined)
  )
    throw new Error("No matching owner-confirmed instruction");
  requested?.check();
  if (requested) requested.claimed = true;
  const current = registered.bind(
    client,
    context,
    tool,
    requested ? native.instruction : undefined,
  );
  if (
    requested &&
    (current.viewer !== requested.owner ||
      current.community !== requested.community)
  ) {
    current.release();
    throw new Error("The instruction community changed");
  }
  let active = true;
  const check = () => {
    if (!active) throw new Error("The agent operation call has ended");
    native.signal.throwIfAborted();
    native.check();
    requested?.check();
    current.check();
  };
  try {
    check();
    if (!client.nativeToolGate)
      await client.protect?.({
        kind: "tool",
        session: JSON.stringify(context),
        content: { title: tool.name, arguments: JSON.parse(input) },
      });
    check();
    // A consumer tool's review does not approve the provider operation.
    await client.protect?.({
      kind: "tool",
      session: JSON.stringify(context),
      content: { title: registered.name, arguments: JSON.parse(input) },
    });
    check();
    // Nor the owner's workspaces: only the agent's own tools file in them.
    const { settings: _, workspaces: __, ...plugin } = client;
    const authority = Object.freeze({
      client: Object.freeze(plugin),
      context,
      signal: native.signal,
      viewer: current.viewer,
      community: current.community,
      ...(requested
        ? {
            instruction: Object.freeze({
              id: requested.id,
              source: requested.source,
            }),
          }
        : {}),
      check,
    });
    const proof = Object.freeze({}) as AgentToolProof;
    proofs.set(proof, { operation, args: input, authority, claimed: false });
    return await tool.call(plugin, context, args, proof);
  } finally {
    active = false;
    current.release();
  }
}

// What an agent shares to its community's catalog (NIP-AP kind 30175) and
// exports as a buzz-agent-snapshot v1 file, the format block/buzz writes. Both
// are built from an explicit allowlist: no key, workspace, environment or
// memory crosses this boundary.
import { avatarSource } from "../../shared/avatar-source";
import { pngChunks } from "../messages/image-metadata";
import { newer, type EventData } from "../relay/events";
import type { RelaySession } from "../relay/session";
import { AGENT_CATALOG_KIND, object } from "./catalog-envelope";
import { delivered } from "./relay-removal";
import type { Agent, RegisteredAgentType } from "./service";
import type { SharedAgent } from "./shared-agents";

/** A shared agent apart from who shared it. */
export type SharedDefinition = Omit<SharedAgent, "id" | "owner">;

const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MAX_PNG_BYTES = 10 * 1024 * 1024;
const PNG = [137, 80, 78, 71, 13, 10, 26, 10];
const KEYWORD = new TextEncoder().encode("buzz_agent_snapshot\0");
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Heuristic only; free text can still hold what it misses. */
const credentialLike = (value: string) =>
  /-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*[^\s,;]{8,})/i.test(
    value,
  );
const https = (value: unknown) => {
  const picture = avatarSource(value);
  return picture?.startsWith("https:") ? picture : undefined;
};
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** What sharing or exporting `agent` publishes. */
export function shareable(
  agent: Agent,
  type: RegisteredAgentType | undefined,
): SharedDefinition {
  const shared = type?.exportShared?.(agent.config);
  if (!type || !shared)
    throw new Error(
      `Agent '${agent.name}' uses a runtime that cannot be shared with the community catalog.`,
    );
  const instructions = type.carry?.(agent.config).instructions ?? "";
  const picture = https(agent.picture);
  const definition = {
    name: agent.name,
    ...(picture && { picture }),
    model: shared.model.trim(),
    runtime: shared.runtime,
    ...(shared.provider?.trim() && { provider: shared.provider.trim() }),
    instructions,
  };
  if (
    [definition.name, instructions, definition.model, shared.provider ?? ""]
      .filter(Boolean)
      .some(credentialLike)
  )
    throw new Error(
      "Portable configuration appears to contain a credential. Remove it before export.",
    );
  return definition;
}

/** A kind 30175 body, in NIP-AP field order. */
export function catalogContent(definition: SharedDefinition): string {
  const { name, picture, instructions, runtime, model, provider } = definition;
  return JSON.stringify({
    display_name: name,
    system_prompt: instructions,
    ...(picture && { avatar_url: picture }),
    runtime,
    ...(model && { model }),
    ...(provider && { provider }),
  });
}

/** The owner's newest catalog head for the agent, which is addressed by its
 * pubkey. The relay shows an author their own unshared heads. */
export async function catalogHead(
  session: Pick<RelaySession, "read">,
  owner: string,
  pubkey: string,
  signal: AbortSignal,
): Promise<EventData | undefined> {
  const events = await session.read(
    [
      {
        kinds: [AGENT_CATALOG_KIND],
        authors: [owner],
        "#d": [pubkey],
        limit: 10,
        consistency: "strong",
      },
    ],
    { signal, fresh: true },
  );
  return events
    .filter((event) => event.pubkey === owner)
    .reduce<EventData | undefined>(newer, undefined);
}

export const isShared = (head: EventData | undefined) =>
  !!head?.tags.some(([name, value]) => name === "shared" && value === "true");

/** Replaces `head` with `content`, shared or not, once the relay accepts it.
 * Unshared, the relay keeps it from everyone but its author. */
export async function publishShare(
  session: Pick<RelaySession, "outbox">,
  pubkey: string,
  content: string,
  shared: boolean,
  head: EventData | undefined,
  signal: AbortSignal,
): Promise<void> {
  const outbox = session.outbox;
  if (!outbox?.supports(AGENT_CATALOG_KIND))
    throw new Error("This community cannot update catalog sharing.");
  await outbox.ready();
  signal.throwIfAborted();
  const id = outbox.send(
    {
      kind: AGENT_CATALOG_KIND,
      content,
      tags: [["d", pubkey], ...(shared ? [["shared", "true"]] : [])],
      ...(head && { supersedes: head.created_at }),
    },
    undefined,
    () => !signal.aborted,
  );
  await delivered(outbox, id, signal, "Try again.");
  await outbox.dismiss(id);
}

/** A buzz-agent-snapshot v1 `.agent.json` without memory. */
export function snapshotJson(definition: SharedDefinition): string {
  const { name, picture, instructions, runtime, model, provider } = definition;
  return JSON.stringify(
    {
      format: "buzz-agent-snapshot",
      version: 1,
      definition: {
        name,
        ...(instructions && { systemPrompt: instructions }),
        runtime,
        ...(model && { model }),
        ...(provider && { provider }),
      },
      profile: { displayName: name, ...(picture && { avatarUrl: picture }) },
      memory: { level: "none", entries: [] },
    },
    null,
    2,
  );
}

/** The base64 manifest in a snapshot PNG's `buzz_agent_snapshot` tEXt chunk. */
function pngManifest(bytes: Uint8Array): Uint8Array {
  let chunks: ReturnType<typeof pngChunks>;
  try {
    chunks = pngChunks(bytes);
  } catch {
    throw new Error("Invalid PNG snapshot.");
  }
  const chunk = chunks.find(
    ({ kind, payload }) =>
      kind === "tEXt" && KEYWORD.every((byte, i) => payload[i] === byte),
  );
  if (!chunk)
    throw new Error("PNG does not contain a buzz_agent_snapshot tEXt chunk.");
  try {
    const encoded = decoder.decode(chunk.payload.subarray(KEYWORD.length));
    return Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  } catch {
    throw new Error("Invalid PNG snapshot.");
  }
}

/** Reads an `.agent.json` or `.agent.png` snapshot. What a Buzz agent has no
 * place for, such as memory or an inline avatar, stays behind. */
export function readSnapshot(bytes: Uint8Array): SharedDefinition {
  const png = PNG.every((byte, i) => bytes[i] === byte);
  if (bytes.length > (png ? MAX_PNG_BYTES : MAX_JSON_BYTES))
    throw new Error("Snapshot exceeds the size limit.");
  const manifest = png ? pngManifest(bytes) : bytes;
  let snapshot: Record<string, unknown> | undefined;
  try {
    snapshot = object(decoder.decode(manifest));
  } catch {}
  if (!snapshot) throw new Error("Invalid snapshot JSON.");
  if (snapshot.format !== "buzz-agent-snapshot")
    throw new Error("Unsupported snapshot format.");
  if (snapshot.version !== 1) throw new Error("Unsupported snapshot version.");
  const definition = record(snapshot.definition);
  const profile = record(snapshot.profile);
  const name = text(profile.displayName) || text(definition.name);
  if (!name) throw new Error("Display name is required");
  const picture = https(profile.avatarUrl);
  const runtime = text(definition.runtime);
  const provider = text(definition.provider);
  return {
    name,
    ...(picture && { picture }),
    model: text(definition.model),
    ...(runtime && { runtime }),
    ...(provider && { provider }),
    instructions:
      typeof definition.systemPrompt === "string"
        ? definition.systemPrompt
        : "",
  };
}

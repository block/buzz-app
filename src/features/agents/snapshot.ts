/** Portable buzz-agent-snapshot v1. No saved identity or local execution state crosses this boundary. */
import type { AgentView } from "./control";
import { memorySlug, type MemoryEntry } from "./memory";

const MAX_FILE = 4 * 1024 * 1024;
const MAGIC = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const keyword = encoder.encode("buzz_agent_snapshot\0");

export type MemoryLevel = "none" | "core" | "everything";
export interface AgentSnapshot {
  format: "buzz-agent-snapshot";
  version: 1;
  definition: {
    name: string;
    sourceIsBuiltIn?: boolean;
    systemPrompt?: string;
    runtime?: string;
    model?: string;
    provider?: string;
    sessionPolicy?: "channel" | "thread";
    respondTo?: "owner-only" | "allowlist" | "anyone";
    respondToAllowlist?: string[];
    parallelism?: number;
    namePool?: string[];
    idleTimeoutSeconds?: number;
    maxTurnDurationSeconds?: number;
  };
  profile: {
    displayName: string;
    about?: string;
    avatarDataUrl?: string;
    avatarUrl?: string;
  };
  memory: { level: MemoryLevel; entries: { slug: string; body: string }[] };
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max && !value.includes("\0");
const optionalText = (value: unknown, max: number) =>
  value === undefined || text(value, max);
const keys = (record: Record<string, unknown>, allowed: string[]) =>
  Object.keys(record).every((key) => allowed.includes(key));

/** Fail closed on unknown fields: a future writer cannot smuggle credentials as "config". */
export function parseAgentSnapshot(bytes: Uint8Array): AgentSnapshot {
  if (bytes.length > MAX_FILE)
    throw new Error("Snapshot exceeds the size limit.");
  const raw =
    bytes.length >= 8 &&
    bytes.subarray(0, 8).every((byte, i) => byte === MAGIC[i])
      ? pngManifest(bytes)
      : bytes;
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(raw));
  } catch {
    throw new Error("Invalid snapshot JSON.");
  }
  if (!isRecord(value)) throw new Error("Invalid snapshot JSON.");
  if (value.format !== "buzz-agent-snapshot")
    throw new Error("Unsupported snapshot format.");
  if (value.version !== 1) throw new Error("Unsupported snapshot version.");
  const { definition: d, profile: p, memory: m } = value;
  if (
    !keys(value, ["format", "version", "definition", "profile", "memory"]) ||
    !isRecord(d) ||
    !isRecord(p) ||
    !isRecord(m) ||
    !keys(d, [
      "name",
      "sourceIsBuiltIn",
      "systemPrompt",
      "runtime",
      "model",
      "provider",
      "parallelism",
      "sessionPolicy",
      "respondTo",
      "respondToAllowlist",
      "namePool",
      "idleTimeoutSeconds",
      "maxTurnDurationSeconds",
    ]) ||
    !keys(p, ["displayName", "about", "avatarDataUrl", "avatarUrl"]) ||
    !keys(m, ["level", "entries"]) ||
    !text(d.name, 256) ||
    !(d.name as string).trim() ||
    !text(p.displayName, 256) ||
    !(p.displayName as string).trim() ||
    (d.sourceIsBuiltIn !== undefined &&
      typeof d.sourceIsBuiltIn !== "boolean") ||
    !optionalText(d.systemPrompt, 128 * 1024) ||
    !optionalText(d.runtime, 128) ||
    !optionalText(d.model, 512) ||
    !optionalText(d.provider, 128) ||
    !["channel", "thread", undefined].includes(
      d.sessionPolicy as string | undefined,
    ) ||
    !["owner-only", "allowlist", "anyone", undefined].includes(
      d.respondTo as string | undefined,
    ) ||
    (d.respondTo !== undefined && d.respondTo !== "owner-only") ||
    (d.respondToAllowlist !== undefined &&
      (!Array.isArray(d.respondToAllowlist) ||
        d.respondToAllowlist.length !== 0)) ||
    d.namePool !== undefined ||
    d.runtime !== undefined ||
    p.about !== undefined ||
    d.parallelism !== undefined ||
    d.idleTimeoutSeconds !== undefined ||
    d.maxTurnDurationSeconds !== undefined ||
    !optionalText(p.about, 2048) ||
    (p.avatarDataUrl !== undefined &&
      (typeof p.avatarDataUrl !== "string" ||
        !/^data:image\/(png|jpeg|gif|webp);base64,[a-zA-Z0-9+/]+=*$/.test(
          p.avatarDataUrl,
        ) ||
        p.avatarDataUrl.length > 2_800_000)) ||
    (p.avatarUrl !== undefined &&
      (typeof p.avatarUrl !== "string" ||
        !/^https:\/\/[^\s@?#]+$/.test(p.avatarUrl) ||
        p.avatarUrl.length > 2048)) ||
    !["none", "core", "everything"].includes(m.level as string) ||
    (m.entries !== undefined && !Array.isArray(m.entries)) ||
    (Array.isArray(m.entries) &&
      (m.entries.length > 128 ||
        !m.entries.every(
          (e) =>
            isRecord(e) &&
            keys(e, ["slug", "body"]) &&
            memorySlug(e.slug) &&
            text(e.body, 64 * 1024) &&
            encoder.encode(e.body as string).length <= 64 * 1024,
        ) ||
        (m.level === "none" && m.entries.length !== 0) ||
        (m.level === "core" && m.entries.some((e) => e.slug !== "core")) ||
        new Set(m.entries.map((e) => e.slug)).size !== m.entries.length ||
        encoder.encode(JSON.stringify(m.entries)).length > 1024 * 1024))
  )
    throw new Error("Invalid snapshot manifest.");
  return {
    ...value,
    memory: { ...m, entries: m.entries ?? [] },
  } as AgentSnapshot;
}

/** Explicit allowlist. In particular args, workspace, environment, imported blobs, and identity are absent. */
export function buildAgentSnapshot(
  agent: AgentView,
  level: MemoryLevel = "none",
  memories: readonly Pick<MemoryEntry, "slug" | "body">[] = [],
): AgentSnapshot {
  const entries =
    level === "none"
      ? []
      : memories
          .filter((entry) => level === "everything" || entry.slug === "core")
          .map(({ slug, body }) => ({ slug, body }));
  const snapshot: AgentSnapshot = {
    format: "buzz-agent-snapshot",
    version: 1,
    definition: {
      name: agent.name,
      systemPrompt: agent.systemPrompt,
      ...(agent.harness.model ? { model: agent.harness.model } : {}),
      ...(agent.harness.provider ? { provider: agent.harness.provider } : {}),
      sessionPolicy: agent.sessionPolicy ?? "thread",
    },
    profile: {
      displayName: agent.name,
      ...(agent.picture && /^https:\/\/[^\s@?#]+$/.test(agent.picture)
        ? { avatarUrl: agent.picture }
        : {}),
    },
    memory: { level, entries },
  };
  parseAgentSnapshot(encoder.encode(JSON.stringify(snapshot)));
  return snapshot;
}

function u32(bytes: Uint8Array, at: number) {
  return (
    ((bytes[at] ?? 0) * 0x1000000 +
      ((bytes[at + 1] ?? 0) << 16) +
      ((bytes[at + 2] ?? 0) << 8) +
      (bytes[at + 3] ?? 0)) >>>
    0
  );
}
function put32(bytes: Uint8Array, at: number, value: number) {
  bytes[at] = value >>> 24;
  bytes[at + 1] = value >>> 16;
  bytes[at + 2] = value >>> 8;
  bytes[at + 3] = value;
}
function crc(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array) {
  const result = new Uint8Array(data.length + 12);
  put32(result, 0, data.length);
  result.set(encoder.encode(type), 4);
  result.set(data, 8);
  put32(result, 8 + data.length, crc(result.subarray(4, 8 + data.length)));
  return result;
}
const concat = (parts: Uint8Array[]) => {
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};
/** RFC 2083 tEXt chunk: base64 JSON, same keyword/encoding as block/buzz. */
export function encodeAgentSnapshot(
  snapshot: AgentSnapshot,
  format: "json" | "png",
) {
  const { entries, ...memory } = snapshot.memory;
  const manifest = encoder.encode(
    JSON.stringify(
      {
        ...snapshot,
        memory: entries.length ? snapshot.memory : memory,
      },
      null,
      2,
    ),
  );
  parseAgentSnapshot(manifest);
  if (format === "json") return manifest;
  const ihdr = new Uint8Array(13);
  put32(ihdr, 0, 1);
  put32(ihdr, 4, 1);
  ihdr[8] = 8;
  ihdr[9] = 6;
  // Zlib stored block containing filter 0 and transparent RGBA; Adler-32 = 0x00050001.
  const pixel = new Uint8Array([
    0x78, 0x01, 0x01, 0x05, 0x00, 0xfa, 0xff, 0, 0, 0, 0, 0, 0x00, 0x05, 0x00,
    0x01,
  ]);
  const base64 = btoa(
    Array.from(manifest, (byte) => String.fromCharCode(byte)).join(""),
  );
  const png = concat([
    MAGIC,
    chunk("IHDR", ihdr),
    chunk("tEXt", concat([keyword, encoder.encode(base64)])),
    chunk("IDAT", pixel),
    chunk("IEND", new Uint8Array()),
  ]);
  if (png.length > MAX_FILE)
    throw new Error("Snapshot exceeds the size limit.");
  return png;
}
function pngManifest(bytes: Uint8Array) {
  let offset = 8,
    found: Uint8Array | undefined,
    image = false,
    ended = false;
  while (offset + 12 <= bytes.length) {
    const length = u32(bytes, offset);
    if (length > MAX_FILE || offset + 12 + length > bytes.length)
      throw new Error("Invalid PNG snapshot.");
    const type = decoder.decode(bytes.subarray(offset + 4, offset + 8));
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    if (
      u32(bytes, offset + 8 + length) !==
      crc(bytes.subarray(offset + 4, offset + 8 + length))
    )
      throw new Error("Invalid PNG snapshot.");
    if (
      offset === 8 &&
      (type !== "IHDR" ||
        length !== 13 ||
        !u32(payload, 0) ||
        !u32(payload, 4) ||
        u32(payload, 0) > 2048 ||
        u32(payload, 4) > 2048)
    )
      throw new Error("Invalid PNG snapshot.");
    if (type === "IDAT") image = true;
    if (
      type === "tEXt" &&
      payload.length >= keyword.length &&
      payload.subarray(0, keyword.length).every((b, i) => b === keyword[i]) &&
      payload[keyword.length - 1] === 0
    ) {
      if (found) throw new Error("Invalid PNG snapshot.");
      const encoded = decoder.decode(payload.subarray(keyword.length));
      if (!/^[a-zA-Z0-9+/]+=*$/.test(encoded))
        throw new Error("Invalid PNG snapshot.");
      try {
        found = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
      } catch {
        throw new Error("Invalid PNG snapshot.");
      }
    }
    offset += length + 12;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  if (!image || !ended || offset !== bytes.length || !found)
    throw new Error("PNG does not contain a buzz_agent_snapshot tEXt chunk.");
  return found;
}

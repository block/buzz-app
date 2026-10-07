/** Portable buzz-agent-snapshot v1. No saved identity or local execution state crosses this boundary. */
import type { AgentEdit, AgentView, ControlSnapshot } from "./control";
import { memorySlug, type MemoryEntry } from "./memory";

export const MAX_AGENT_SNAPSHOT_FILE_BYTES = 4 * 1024 * 1024;
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
    sourceIsBuiltin?: boolean;
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
  typeof value === "string" &&
  encoder.encode(value).length <= max &&
  !value.includes("\0");
const invisible = (char: string) => {
  const code = char.codePointAt(0) ?? 0;
  return (
    code === 0xad ||
    code === 0x34f ||
    code === 0x61c ||
    (code >= 0x115f && code <= 0x1160) ||
    (code >= 0x17b4 && code <= 0x17b5) ||
    (code >= 0x180b && code <= 0x180f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0x3164 ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    code === 0xfeff ||
    code === 0xffa0 ||
    (code >= 0xfff0 && code <= 0xfff8) ||
    (code >= 0x1bca0 && code <= 0x1bca3) ||
    (code >= 0x1d173 && code <= 0x1d17a) ||
    (code >= 0xe0000 && code <= 0xe0fff)
  );
};
/** Reviewable text: permit only contextual emoji joiners/selectors. */
export function visibleSnapshotText(value: string, prompt = false): boolean {
  const chars = Array.from(value);
  const pictographic = (char: string) =>
    /^\p{Extended_Pictographic}$/u.test(char);
  for (const [i, char] of chars.entries()) {
    if (/[\p{Cc}]/u.test(char) && !(prompt && (char === "\n" || char === "\t")))
      return false;
    if (!invisible(char)) continue;
    if (
      char === "\uFE0F" &&
      (/[#*0-9]/.test(chars[i - 1] ?? "") || pictographic(chars[i - 1] ?? ""))
    )
      continue;
    if (char === "\u200D" && pictographic(chars[i + 1] ?? "")) {
      let previous = i - 1;
      while (
        previous >= 0 &&
        (chars[previous] === "\uFE0F" ||
          /[\u{1F3FB}-\u{1F3FF}]/u.test(chars[previous] ?? ""))
      )
        previous--;
      if (pictographic(chars[previous] ?? "")) continue;
    }
    return false;
  }
  return true;
}
/** Heuristic only. The export UI also discloses residual free-text risk. */
const credentialLike = (value: string) =>
  /-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*[^\s,;]{8,})/i.test(
    value,
  );
const optionalText = (value: unknown, max: number) =>
  value === undefined || text(value, max);
const keys = (record: Record<string, unknown>, allowed: string[]) =>
  Object.keys(record).every((key) => allowed.includes(key));

/** Fail closed on unknown fields: a future writer cannot smuggle credentials as "config". */
export function parseAgentSnapshot(bytes: Uint8Array): AgentSnapshot {
  if (bytes.length > MAX_AGENT_SNAPSHOT_FILE_BYTES)
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
      "sourceIsBuiltin",
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
    (d.sourceIsBuiltin !== undefined &&
      typeof d.sourceIsBuiltin !== "boolean") ||
    !optionalText(d.systemPrompt, 64 * 1024) ||
    (typeof d.systemPrompt === "string" &&
      !visibleSnapshotText(d.systemPrompt, true)) ||
    !visibleSnapshotText(d.name as string) ||
    !visibleSnapshotText(p.displayName as string) ||
    !optionalText(d.runtime, 128) ||
    (typeof d.runtime === "string" && !visibleSnapshotText(d.runtime)) ||
    !optionalText(d.model, 512) ||
    (typeof d.model === "string" && !visibleSnapshotText(d.model)) ||
    !optionalText(d.provider, 128) ||
    (typeof d.provider === "string" && !visibleSnapshotText(d.provider)) ||
    !["channel", "thread", undefined].includes(
      d.sessionPolicy as string | undefined,
    ) ||
    !["owner-only", "allowlist", "anyone", undefined].includes(
      d.respondTo as string | undefined,
    ) ||
    (d.respondToAllowlist !== undefined &&
      (!Array.isArray(d.respondToAllowlist) ||
        d.respondToAllowlist.length > 128 ||
        !d.respondToAllowlist.every((v: unknown) => text(v, 256)))) ||
    (d.namePool !== undefined &&
      (!Array.isArray(d.namePool) ||
        d.namePool.length > 128 ||
        !d.namePool.every((v: unknown) => text(v, 256)))) ||
    (d.parallelism !== undefined &&
      (!Number.isSafeInteger(d.parallelism) ||
        (d.parallelism as number) < 1 ||
        (d.parallelism as number) > 0xffffffff)) ||
    (d.idleTimeoutSeconds !== undefined &&
      (!Number.isSafeInteger(d.idleTimeoutSeconds) ||
        (d.idleTimeoutSeconds as number) < 0)) ||
    (d.maxTurnDurationSeconds !== undefined &&
      (!Number.isSafeInteger(d.maxTurnDurationSeconds) ||
        (d.maxTurnDurationSeconds as number) < 0)) ||
    !optionalText(p.about, 2048) ||
    (typeof p.about === "string" && !visibleSnapshotText(p.about, true)) ||
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
  defaultSessionPolicy?: "channel" | "thread",
): AgentSnapshot {
  if (
    agent.harness.command !== "buzz-agent" ||
    agent.respondTo !== "owner-only" ||
    agent.launchModelEnv ||
    agent.launchProviderEnv ||
    agent.backend ||
    agent.harness.databricks ||
    agent.harness.environmentKeys.some((key) => key !== "BUZZ_ACP_AGENTS") ||
    (agent.harness.environmentKeys.includes("BUZZ_ACP_AGENTS") &&
      agent.launchParallelism == null) ||
    (agent.launchParallelism != null &&
      (!Number.isInteger(agent.launchParallelism) ||
        agent.launchParallelism < 1 ||
        agent.launchParallelism > 32)) ||
    (agent.sessionPolicy === null && !defaultSessionPolicy)
  ) {
    throw new Error(
      "This agent has runtime, response, or environment settings that cannot be exported faithfully.",
    );
  }
  for (const value of [
    agent.name,
    agent.systemPrompt,
    agent.launchModel ?? "",
    agent.launchProvider ?? "",
    agent.picture ?? "",
  ]) {
    if (credentialLike(value))
      throw new Error(
        "Portable configuration appears to contain a credential. Remove it before export.",
      );
  }
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
      ...(agent.launchModel ? { model: agent.launchModel } : {}),
      ...(agent.launchProvider ? { provider: agent.launchProvider } : {}),
      ...(agent.launchParallelism != null
        ? { parallelism: agent.launchParallelism }
        : {}),
      runtime: "buzz-agent",
      respondTo: "owner-only",
      sessionPolicy: agent.sessionPolicy ?? defaultSessionPolicy ?? "thread",
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

export type SnapshotImportOptions = Pick<
  ControlSnapshot,
  "defaultWorkspace" | "harnessOptions"
>;

/** The portable definition is the only authority for both standalone and team creation.
 * Absent session policy means channel (reference v1 behavior); absent worker count
 * leaves the destination default untouched. Explicit counts override that default.
 * Explicit empty selectors clear inherited model/provider values. The native edit
 * has no nullable selectors or profile-about field: reject unsupported values.
 */
export function snapshotImportEdit(
  snapshot: AgentSnapshot,
  options: SnapshotImportOptions,
): AgentEdit {
  const limitations = snapshotLimitations(snapshot);
  if (limitations.length)
    throw new Error(`Import is blocked: ${limitations.join("; ")}.`);
  const selected = options.harnessOptions?.find(
    (option) => option.available !== false && option.command === "buzz-agent",
  );
  if (!selected)
    throw new Error("Buzz Agent is unavailable. Install it in Settings first.");
  return {
    name: snapshot.profile.displayName,
    systemPrompt: snapshot.definition.systemPrompt ?? "",
    sessionPolicy: snapshot.definition.sessionPolicy ?? "channel",
    workspace: options.defaultWorkspace ?? "",
    harness: {
      command: "buzz-agent",
      args: selected.defaultArgs ?? [],
      model: snapshot.definition.model ?? "",
      provider: snapshot.definition.provider ?? "",
      databricks: null,
    },
    environment:
      snapshot.definition.parallelism === undefined
        ? {}
        : { BUZZ_ACP_AGENTS: String(snapshot.definition.parallelism) },
    ...(snapshot.profile.avatarUrl
      ? { picture: snapshot.profile.avatarUrl }
      : {}),
  };
}

/** A valid v1 manifest can describe settings that native AgentEdit cannot persist. */
export function snapshotLimitations(snapshot: AgentSnapshot): string[] {
  const d = snapshot.definition;
  return [
    ...(d.name !== snapshot.profile.displayName
      ? ["definition and profile names disagree"]
      : []),
    ...(d.runtime !== undefined && d.runtime !== "buzz-agent"
      ? ["runtime (unsupported)"]
      : []),
    ...(d.respondTo && d.respondTo !== "owner-only" ? ["response policy"] : []),
    ...(d.respondToAllowlist?.length ? ["source response allowlist"] : []),
    // Native listener workers accept 1..=32; a larger reference request cannot
    // be silently clamped without changing the agent's behavior.
    ...(d.parallelism !== undefined && d.parallelism > 32
      ? ["parallelism (native supports 1–32 workers)"]
      : []),
    ...(d.namePool?.length ? ["name pool"] : []),
    ...(d.idleTimeoutSeconds !== undefined ? ["idle timeout"] : []),
    ...(d.maxTurnDurationSeconds !== undefined ? ["turn timeout"] : []),
    ...(snapshot.profile.about ? ["profile about"] : []),
  ];
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
  artwork?: Uint8Array,
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
  let imageParts: Uint8Array[] = [
    chunk("IHDR", ihdr),
    chunk("IDAT", pixel),
    chunk("IEND", new Uint8Array()),
  ];
  if (artwork) {
    // Artwork comes from a canvas-produced PNG. Never copy its ancillary metadata.
    const parts: Uint8Array[] = [];
    let at = 8;
    if (
      artwork.length > MAX_AGENT_SNAPSHOT_FILE_BYTES ||
      !artwork.subarray(0, 8).every((v, i) => v === MAGIC[i])
    )
      throw new Error("Invalid snapshot artwork.");
    while (at + 12 <= artwork.length) {
      const length = u32(artwork, at);
      if (at + length + 12 > artwork.length)
        throw new Error("Invalid snapshot artwork.");
      const type = decoder.decode(artwork.subarray(at + 4, at + 8));
      if (
        u32(artwork, at + 8 + length) !==
        crc(artwork.subarray(at + 4, at + 8 + length))
      )
        throw new Error("Invalid snapshot artwork.");
      if (["IHDR", "IDAT", "IEND"].includes(type))
        parts.push(artwork.slice(at, at + length + 12));
      at += length + 12;
      if (type === "IEND") break;
    }
    if (
      at !== artwork.length ||
      parts.length < 3 ||
      decoder.decode(parts[0]?.subarray(4, 8)) !== "IHDR" ||
      decoder.decode(parts.at(-1)?.subarray(4, 8)) !== "IEND"
    )
      throw new Error("Invalid snapshot artwork.");
    imageParts = parts;
  }
  const png = concat([
    MAGIC,
    imageParts[0] ?? chunk("IHDR", ihdr),
    chunk("tEXt", concat([keyword, encoder.encode(base64)])),
    ...imageParts.slice(1),
  ]);
  if (png.length > MAX_AGENT_SNAPSHOT_FILE_BYTES)
    throw new Error("Snapshot exceeds the size limit.");
  parseAgentSnapshot(png);
  return png;
}
function pngManifest(bytes: Uint8Array) {
  let offset = 8,
    found: Uint8Array | undefined,
    image = false,
    ended = false;
  while (offset + 12 <= bytes.length) {
    const length = u32(bytes, offset);
    if (
      length > MAX_AGENT_SNAPSHOT_FILE_BYTES ||
      offset + 12 + length > bytes.length
    )
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

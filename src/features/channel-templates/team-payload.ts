import type { TeamSnapshot } from "../agents/team-bundles.ts";

export const TEAM_PAYLOAD_TAG = "buzz-team-payload-v1";
export const TEAM_MANIFEST_TAG = "buzz-channel-kit-v2";
export const TEAM_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const TEAM_CHUNK_BYTES = 16 * 1024;
export const TEAM_CHUNKS = TEAM_PAYLOAD_BYTES / TEAM_CHUNK_BYTES;
export interface TeamManifest {
  version: 1;
  owner: string;
  revision: string;
  digest: string;
  bytes: number;
  chunks: number;
}
export interface TeamPayload {
  version: 1;
  community: string;
  owner: string;
  teamId: string;
  revision: string;
  index: number;
  data: string;
}
const hexKey = /^[0-9a-f]{64}$/;
const identifier = /^[a-zA-Z0-9_-]{1,128}$/;
const revision = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export function parseTeamManifest(raw: unknown): TeamManifest {
  const value = raw as TeamManifest | undefined;
  if (
    value?.version !== 1 ||
    !hexKey.test(value.owner) ||
    !revision.test(value.revision) ||
    !hexKey.test(value.digest) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > TEAM_PAYLOAD_BYTES ||
    value.chunks !== Math.ceil(value.bytes / TEAM_CHUNK_BYTES)
  )
    throw new Error("Invalid portable team manifest");
  return {
    version: 1,
    owner: value.owner,
    revision: value.revision,
    digest: value.digest,
    bytes: value.bytes,
    chunks: value.chunks,
  };
}
export function parseTeamPayload(raw: unknown, community: string): TeamPayload {
  const value = raw as TeamPayload | undefined;
  if (
    value?.version !== 1 ||
    value.community !== community ||
    !hexKey.test(value.owner) ||
    !identifier.test(value.teamId) ||
    !revision.test(value.revision) ||
    !Number.isSafeInteger(value.index) ||
    value.index < 0 ||
    value.index >= TEAM_CHUNKS ||
    typeof value.data !== "string" ||
    value.data.length > Math.ceil(TEAM_CHUNK_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value.data,
    )
  )
    throw new Error("Invalid portable team payload");
  return {
    version: 1,
    community,
    owner: value.owner,
    teamId: value.teamId,
    revision: value.revision,
    index: value.index,
    data: value.data,
  };
}
export function payloadCoordinate(
  value: Omit<TeamPayload, "data" | "version">,
) {
  return `${TEAM_PAYLOAD_TAG}:${encodeURIComponent(value.community)}:${value.owner}:${value.teamId}:${value.revision}:${value.index}`;
}
async function digest(bytes: Uint8Array<ArrayBuffer>) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
/** Only portable configuration travels to persistence; memory is restored separately. */
export function withoutTeamMemories(snapshot: TeamSnapshot): TeamSnapshot {
  return {
    ...snapshot,
    members: snapshot.members.map((member) => ({
      ...member,
      memory: { level: "none", entries: [] },
    })),
  };
}
/** Splits bytes into immutable digest-bound chunks for one revision. */
async function encodePayloadBytes(
  bytes: Uint8Array<ArrayBuffer>,
  community: string,
  owner: string,
  teamId: string,
  operationRevision: string,
  parseManifest: (raw: unknown) => TeamManifest,
) {
  const manifest = parseManifest({
    version: 1,
    owner,
    revision: operationRevision,
    digest: await digest(bytes),
    bytes: bytes.length,
    chunks: Math.ceil(bytes.length / TEAM_CHUNK_BYTES),
  });
  const payloads: TeamPayload[] = [];
  for (let index = 0; index < manifest.chunks; index++) {
    const chunk = bytes.subarray(
      index * TEAM_CHUNK_BYTES,
      (index + 1) * TEAM_CHUNK_BYTES,
    );
    let binary = "";
    for (const byte of chunk) binary += String.fromCharCode(byte);
    payloads.push(
      parseTeamPayload(
        {
          version: 1,
          community,
          owner,
          teamId,
          revision: manifest.revision,
          index,
          data: btoa(binary),
        },
        community,
      ),
    );
  }
  return { manifest, payloads };
}
/** Host decode already verifies signature/owner. Checks every immutable
 * binding, exact chunk length and the digest before returning bytes. */
async function decodePayloadBytes(
  manifest: TeamManifest,
  payloads: readonly TeamPayload[],
  community: string,
  owner: string,
  teamId: string,
) {
  if (manifest.owner !== owner || payloads.length !== manifest.chunks)
    throw new Error("Incomplete portable team payload");
  const bytes = new Uint8Array(manifest.bytes);
  for (let index = 0; index < payloads.length; index++) {
    const payload = parseTeamPayload(payloads[index], community);
    if (
      payload.owner !== owner ||
      payload.teamId !== teamId ||
      payload.revision !== manifest.revision ||
      payload.index !== index
    )
      throw new Error("Portable team revision mismatch");
    const binary = atob(payload.data);
    const expected = Math.min(
      TEAM_CHUNK_BYTES,
      manifest.bytes - index * TEAM_CHUNK_BYTES,
    );
    if (binary.length !== expected || btoa(binary) !== payload.data)
      throw new Error("Invalid portable team chunk size");
    bytes.set(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
      index * TEAM_CHUNK_BYTES,
    );
  }
  if ((await digest(bytes)) !== manifest.digest)
    throw new Error("Portable team integrity check failed");
  return bytes;
}
export async function encodeTeamPayload(
  snapshot: TeamSnapshot,
  community: string,
  owner: string,
  teamId: string,
  operationRevision: string = crypto.randomUUID(),
) {
  const bytes = new TextEncoder().encode(
    JSON.stringify(withoutTeamMemories(snapshot)),
  );
  if (!bytes.length || bytes.length > TEAM_PAYLOAD_BYTES)
    throw new Error("Team snapshot exceeds the size limit");
  return encodePayloadBytes(
    bytes,
    community,
    owner,
    teamId,
    operationRevision,
    parseTeamManifest,
  );
}
export async function decodeTeamPayload(
  manifestValue: TeamManifest,
  payloads: readonly TeamPayload[],
  community: string,
  owner: string,
  teamId: string,
): Promise<unknown> {
  const bytes = await decodePayloadBytes(
    parseTeamManifest(manifestValue),
    payloads,
    community,
    owner,
    teamId,
  );
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** Team instructions travel as ASCII `v1:` plus their raw UTF-8 bytes. */
export const TEAM_TEXT_BYTES = 128 * 1024;
const TEXT_PREFIX = "v1:";
export function parseTextManifest(raw: unknown): TeamManifest {
  const manifest = parseTeamManifest(raw);
  if (
    // Exactly the six manifest fields, as native admission requires.
    Object.keys(raw as object).length !== 6 ||
    manifest.bytes < TEXT_PREFIX.length ||
    manifest.bytes > TEXT_PREFIX.length + TEAM_TEXT_BYTES
  )
    throw new Error("Invalid team instructions manifest");
  return manifest;
}
/** Valid UTF-8, no NUL and at most 128 KiB before any trimming. */
export function teamTextBytes(text: string) {
  const bytes = new TextEncoder().encode(text);
  if (new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) !== text)
    throw new Error("Team instructions must be valid text");
  if (text.includes("\0"))
    throw new Error("Team instructions cannot contain NUL characters");
  if (bytes.length > TEAM_TEXT_BYTES)
    throw new Error("Team instructions exceed 128 KiB");
  return bytes;
}
export function encodeTeamText(
  text: string,
  community: string,
  owner: string,
  teamId: string,
  operationRevision: string,
) {
  const body = teamTextBytes(text);
  const bytes = new Uint8Array(TEXT_PREFIX.length + body.length);
  bytes.set(new TextEncoder().encode(TEXT_PREFIX));
  bytes.set(body, TEXT_PREFIX.length);
  return encodePayloadBytes(
    bytes,
    community,
    owner,
    teamId,
    operationRevision,
    parseTextManifest,
  );
}
export async function decodeTeamText(
  manifestValue: TeamManifest,
  payloads: readonly TeamPayload[],
  community: string,
  owner: string,
  teamId: string,
) {
  const bytes = await decodePayloadBytes(
    parseTextManifest(manifestValue),
    payloads,
    community,
    owner,
    teamId,
  );
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!decoded.startsWith(TEXT_PREFIX))
    throw new Error("Unsupported team instructions format");
  const text = decoded.slice(TEXT_PREFIX.length);
  teamTextBytes(text);
  return text;
}

// Host-only Bestie identity. The owner's key is never persisted or given to the agent.
import { schnorr } from "@noble/curves/secp256k1.js";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools";

const HEX = /^[0-9a-f]{64}$/;
const MAX_BYTES = 512;
const failure = () =>
  new Error(
    "Bestie identity unavailable; check its private state directory. Existing credentials were not replaced.",
  );
const closed = () => new Error("Bestie identity closed");

function defaultDirectory() {
  if (process.platform === "darwin")
    return join(
      homedir(),
      "Library",
      "Application Support",
      "buzz-app",
      "bestie",
    );
  if (process.platform === "win32")
    throw new Error("Bestie identity storage is not available on Windows yet");
  const root = process.env.XDG_STATE_HOME;
  return join(
    root && isAbsolute(root) ? root : join(homedir(), ".local", "state"),
    "buzz-app",
    "bestie",
  );
}

// NIP-OA's domain and authorship differ from NIP-26. Signing uses the same audited
// BIP-340 primitive as nostr-tools; the protocol's published vector covers this seam.
export function ownerAttestation(ownerKey, agentPubkey, conditions) {
  const owner = getPublicKey(ownerKey);
  if (!HEX.test(agentPubkey) || owner === agentPubkey)
    throw new Error("Bestie requires a separate valid agent identity");
  const digest = createHash("sha256")
    .update(`nostr:agent-auth:${agentPubkey}:${conditions}`)
    .digest();
  return JSON.stringify([
    "auth",
    owner,
    conditions,
    Buffer.from(schnorr.sign(digest, ownerKey)).toString("hex"),
  ]);
}

function privateEntry(stat, directory) {
  if (
    !(directory ? stat.isDirectory() : stat.isFile()) ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid()
  )
    throw failure();
}

async function readKey(path, owner) {
  let file;
  const bytes = Buffer.alloc(MAX_BYTES + 1);
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await file.stat();
    privateEntry(stat, false);
    if (stat.size > MAX_BYTES) throw failure();
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size !== stat.size || size > MAX_BYTES) throw failure();
    const record = JSON.parse(bytes.subarray(0, size).toString("utf8"));
    if (
      record?.version !== 1 ||
      record.owner !== owner ||
      typeof record.privateKey !== "string" ||
      !HEX.test(record.privateKey) ||
      Object.keys(record).sort().join(",") !== "owner,privateKey,version"
    )
      throw failure();
    const key = Uint8Array.from(Buffer.from(record.privateKey, "hex"));
    try {
      if (getPublicKey(key) === owner) throw failure();
      return key;
    } catch {
      key.fill(0);
      throw failure();
    }
  } finally {
    bytes.fill(0);
    await file?.close();
  }
}

/** Lazy, owner-scoped host identity. Returned credentials belong only in trusted child environments. */
export function createBestieIdentity({ ownerKey, directory }) {
  // Validate before retaining a private copy; no filesystem work happens at construction.
  const owner = getPublicKey(ownerKey);
  const signingKey = Uint8Array.from(ownerKey);
  let disposed = false,
    loading,
    agentKey;
  const alive = () => {
    if (disposed) throw closed();
  };

  async function load() {
    const root = directory ?? defaultDirectory();
    const path = join(root, `${owner}.json`);
    let temporary, candidate;
    try {
      alive();
      await mkdir(root, { recursive: true, mode: 0o700 });
      privateEntry(await lstat(root), true); // lstat rejects a symlink directory.
      alive();
      try {
        return await readKey(path, owner);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      alive();
      candidate = generateSecretKey();
      const candidatePath = join(
        root,
        `.${owner}.${randomBytes(12).toString("hex")}`,
      );
      const file = await open(
        candidatePath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      temporary = candidatePath;
      try {
        await file.writeFile(
          JSON.stringify({
            version: 1,
            owner,
            privateKey: Buffer.from(candidate).toString("hex"),
          }),
        );
        await file.sync();
      } finally {
        await file.close();
      }
      alive();
      // An atomic, non-replacing link exposes only a fully written record. Parallel
      // hosts converge on the winner rather than replacing an existing identity.
      try {
        await link(temporary, path);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      await unlink(temporary);
      temporary = undefined;
      return await readKey(path, owner);
    } catch {
      throw disposed ? closed() : failure();
    } finally {
      candidate?.fill(0);
      if (temporary)
        await unlink(temporary).catch((error) => {
          if (error.code !== "ENOENT") throw failure();
        });
    }
  }

  return {
    async credentials() {
      alive();
      if (!agentKey) {
        loading ??= load()
          .then((key) => {
            if (disposed) {
              key.fill(0);
              throw closed();
            }
            agentKey = key;
          })
          .finally(() => {
            loading = undefined;
          });
        await loading;
      }
      alive();
      const pubkey = getPublicKey(agentKey);
      // Covers the host's one-hour call limit; renewed per call, never saved on disk.
      const conditions = `created_at<${Math.floor(Date.now() / 1000) + 7200}`;
      return {
        pubkey,
        privateKey: Buffer.from(agentKey).toString("hex"),
        authTag: ownerAttestation(signingKey, pubkey, conditions),
      };
    },
    dispose() {
      disposed = true;
      signingKey.fill(0);
      agentKey?.fill(0);
    },
  };
}

import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools";
import { createBestieIdentity, ownerAttestation } from "./bestie-identity.mjs";

const cleanup = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function fixture(ownerKey = generateSecretKey()) {
  const directory = await mkdtemp(join(tmpdir(), "bestie-identity-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const identity = createBestieIdentity({ ownerKey, directory });
  cleanup.push(() => identity.dispose());
  return {
    ownerKey,
    directory,
    identity,
    path: join(directory, `${getPublicKey(ownerKey)}.json`),
  };
}
function validAttestation(tag, pubkey) {
  const [label, owner, conditions, signature] = JSON.parse(tag);
  expect(label).toBe("auth");
  const digest = createHash("sha256")
    .update(`nostr:agent-auth:${pubkey}:${conditions}`)
    .digest();
  return schnorr.verify(
    Buffer.from(signature, "hex"),
    digest,
    Buffer.from(owner, "hex"),
  );
}

it("matches the NIP-OA published vector and keeps the agent as the signed event author", () => {
  const owner = Uint8Array.from(Buffer.from("1".padStart(64, "0"), "hex"));
  const agent = Uint8Array.from(Buffer.from("2".padStart(64, "0"), "hex"));
  const pubkey = getPublicKey(agent);
  const conditions = "kind=1&created_at<1713957000";
  const digest = createHash("sha256")
    .update(`nostr:agent-auth:${pubkey}:${conditions}`)
    .digest();
  expect(digest.toString("hex")).toBe(
    "08cdecd55af4c28d3801fd69615dcf5cc04fab3bc134b38a840bf157197069a6",
  );
  const published =
    "8b7df2575caf0a108374f8471722b233c53f9ff827a8b0f91861966c3b9dd5cb2e189eae9f49d72187674c2f5bd244145e10ff86c9f257ffe65a1ee5f108b369";
  expect(
    schnorr.verify(
      Buffer.from(published, "hex"),
      digest,
      Buffer.from(getPublicKey(owner), "hex"),
    ),
  ).toBe(true);
  const tag = ownerAttestation(owner, pubkey, conditions);
  expect(validAttestation(tag, pubkey)).toBe(true);
  expect(validAttestation(tag, getPublicKey(generateSecretKey()))).toBe(false);
  const event = finalizeEvent(
    {
      kind: 1,
      created_at: 1713956999,
      tags: [JSON.parse(tag)],
      content: "Fixture message",
    },
    agent,
  );
  expect(verifyEvent(event)).toBe(true);
  expect(event.pubkey).toBe(pubkey);
  expect(event.pubkey).not.toBe(getPublicKey(owner));
  expect(() => ownerAttestation(owner, getPublicKey(owner), "")).toThrow(
    "separate",
  );
});

it("loads lazily, persists the agent independently of its owner, and renews bounded attestations", async () => {
  const f = await fixture();
  expect(await readdir(f.directory)).toEqual([]);
  const before = Math.floor(Date.now() / 1000);
  const first = await f.identity.credentials();
  const saved = JSON.parse(await readFile(f.path, "utf8"));
  expect(saved.owner).toBe(getPublicKey(f.ownerKey));
  expect(saved.privateKey).toBe(first.privateKey);
  expect(saved.privateKey).not.toBe(Buffer.from(f.ownerKey).toString("hex"));
  expect(Object.keys(saved).sort()).toEqual(["owner", "privateKey", "version"]);
  const expiration = Number(
    JSON.parse(first.authTag)[2].slice("created_at<".length),
  );
  expect(expiration).toBeGreaterThanOrEqual(before + 7200);
  expect(expiration).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 7200);
  expect(validAttestation(first.authTag, first.pubkey)).toBe(true);
  vi.spyOn(Date, "now").mockReturnValue((before + 600) * 1000);
  const renewed = await f.identity.credentials();
  expect(JSON.parse(renewed.authTag)[2]).toBe(`created_at<${before + 7800}`);
  expect(renewed.privateKey).toBe(first.privateKey);
  f.identity.dispose();
  expect(getPublicKey(f.ownerKey)).toBe(saved.owner);
  const reopened = createBestieIdentity({
    ownerKey: f.ownerKey,
    directory: f.directory,
  });
  cleanup.push(() => reopened.dispose());
  expect((await reopened.credentials()).privateKey).toBe(first.privateKey);
  const other = createBestieIdentity({
    ownerKey: generateSecretKey(),
    directory: f.directory,
  });
  cleanup.push(() => other.dispose());
  expect((await other.credentials()).pubkey).not.toBe(first.pubkey);
});

it("concurrent independent hosts converge on one complete identity", async () => {
  const f = await fixture();
  const identities = Array.from({ length: 8 }, () =>
    createBestieIdentity({ ownerKey: f.ownerKey, directory: f.directory }),
  );
  cleanup.push(...identities.map((identity) => () => identity.dispose()));
  const credentials = await Promise.all(
    identities.map((identity) => identity.credentials()),
  );
  expect(new Set(credentials.map((item) => item.privateKey)).size).toBe(1);
  expect(await readdir(f.directory)).toEqual([
    `${getPublicKey(f.ownerKey)}.json`,
  ]);
});

it.each([
  "not json",
  JSON.stringify({ version: 2 }),
  JSON.stringify({
    version: 1,
    owner: "wrong",
    privateKey: "1".padStart(64, "0"),
  }),
  "x".repeat(513),
])(
  "rejects malformed existing state without overwriting it (%#)",
  async (bad) => {
    const f = await fixture();
    await writeFile(f.path, bad, { mode: 0o600 });
    await expect(f.identity.credentials()).rejects.toThrow(
      "Existing credentials were not replaced",
    );
    expect(await readFile(f.path, "utf8")).toBe(bad);
  },
);

it("rejects an invalid or owner-equal private key", async () => {
  for (const privateKey of ["0".repeat(64), "owner"]) {
    const f = await fixture();
    await writeFile(
      f.path,
      JSON.stringify({
        version: 1,
        owner: getPublicKey(f.ownerKey),
        privateKey:
          privateKey === "owner"
            ? Buffer.from(f.ownerKey).toString("hex")
            : privateKey,
      }),
      { mode: 0o600 },
    );
    await expect(f.identity.credentials()).rejects.toThrow(
      "identity unavailable",
    );
  }
});

it("rejects symlink records and unsafe file or directory permissions", async () => {
  const f = await fixture();
  const target = join(f.directory, "target");
  await writeFile(target, "do not replace", { mode: 0o600 });
  await symlink(target, f.path);
  await expect(f.identity.credentials()).rejects.toThrow(
    "identity unavailable",
  );
  expect(await readFile(target, "utf8")).toBe("do not replace");
  await rm(f.path);
  await f.identity.credentials();
  f.identity.dispose();
  await chmod(f.path, 0o644);
  const reopened = createBestieIdentity({
    ownerKey: f.ownerKey,
    directory: f.directory,
  });
  cleanup.push(() => reopened.dispose());
  await expect(reopened.credentials()).rejects.toThrow("identity unavailable");
  await chmod(f.path, 0o600);
  await chmod(f.directory, 0o755);
  await expect(reopened.credentials()).rejects.toThrow("identity unavailable");
});

it("rejects a symlink state directory and fences late credential issuance after disposal", async () => {
  const f = await fixture();
  const alias = join(f.directory, "alias");
  await symlink(f.directory, alias);
  const linked = createBestieIdentity({
    ownerKey: f.ownerKey,
    directory: alias,
  });
  cleanup.push(() => linked.dispose());
  await expect(linked.credentials()).rejects.toThrow("identity unavailable");
  const pending = f.identity.credentials();
  f.identity.dispose();
  await expect(pending).rejects.toThrow("identity closed");
  await expect(f.identity.credentials()).rejects.toThrow("identity closed");
  expect(await readdir(f.directory)).toEqual(["alias"]);
});

import { setTimeout as delay } from "node:timers/promises";
import { createHash, createPublicKey, verify } from "node:crypto";
import { finalizeEvent } from "nostr-tools";

const fields = new Set([
  "ownerId",
  "ownerVerifyingKey",
  "ownerBindingSig",
  "ownerEndpointBindingSig",
  "serveTargets",
  "models",
  "node_state",
  "my_vram_gb",
  "model_size_gb",
  "deviceName",
  "endpointId",
]);
const hex = (value, length) =>
  typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
const label = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 512;

/** Dedicated native-worker publication; never extends the generic event signer. */
export function signComputeStatus(payload, viewer, key) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).some((name) => !fields.has(name)) ||
    !hex(payload.ownerId, 64) ||
    !hex(payload.ownerVerifyingKey, 64) ||
    !hex(payload.ownerBindingSig, 128) ||
    !hex(payload.ownerEndpointBindingSig, 128) ||
    !Array.isArray(payload.serveTargets) ||
    payload.serveTargets.length > 32 ||
    !Array.isArray(payload.models) ||
    payload.models.length > 32 ||
    !["serving", "loading", "standby"].includes(payload.node_state)
  )
    throw new Error("Invalid compute status");
  for (const name of ["my_vram_gb", "model_size_gb"])
    if (
      payload[name] !== undefined &&
      (!Number.isFinite(payload[name]) || payload[name] <= 0)
    )
      throw new Error("Invalid compute capacity");
  for (const name of ["deviceName", "endpointId"])
    if (payload[name] !== undefined && !label(payload[name]))
      throw new Error("Invalid device label");
  for (const model of payload.models)
    if (
      !model ||
      Object.keys(model).some((name) => name !== "id" && name !== "name") ||
      !label(model.id) ||
      (model.name !== undefined && !label(model.name))
    )
      throw new Error("Invalid compute model");
  const tokens = payload.serveTargets.map((target) => {
    if (
      !target ||
      Object.keys(target).some(
        (name) => name !== "modelId" && name !== "endpointAddr",
      ) ||
      !label(target.modelId) ||
      typeof target.endpointAddr !== "string" ||
      !target.endpointAddr.trim() ||
      target.endpointAddr.length > 49152
    )
      throw new Error("Invalid compute target");
    return target.endpointAddr.trim();
  });
  const rawKey = Buffer.from(payload.ownerVerifyingKey, "hex");
  if (createHash("sha256").update(rawKey).digest("hex") !== payload.ownerId)
    throw new Error("Invalid compute owner");
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      rawKey,
    ]),
    format: "der",
    type: "spki",
  });
  const digest = createHash("sha256");
  for (const token of [...new Set(tokens)].sort()) {
    const bytes = Buffer.from(token);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    digest.update(length);
    digest.update(bytes);
  }
  const bindings = [
    [payload.ownerBindingSig, `buzz-mesh-owner-binding-v1:${viewer}`],
    [
      payload.ownerEndpointBindingSig,
      `buzz-mesh-owner-endpoint-binding-v1:${viewer}:${digest.digest("hex")}`,
    ],
  ];
  if (
    bindings.some(
      ([signature, message]) =>
        !verify(
          null,
          Buffer.from(message),
          publicKey,
          Buffer.from(signature, "hex"),
        ),
    )
  )
    throw new Error("Invalid compute owner binding");
  return finalizeEvent(
    {
      kind: 30003,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", `buzz-mesh-member-status:${payload.ownerId}`],
        ["k", "buzz-mesh-status"],
      ],
      content: JSON.stringify(payload),
    },
    key,
  );
}

/** Serialize this broker's worker heartbeats so Stop cannot lose a same-second
 * replaceable-event tie to the immediately preceding serving note. */
export function createComputeStatusSigner(
  viewer,
  key,
  now = Date.now,
  wait = delay,
) {
  let tail = Promise.resolve();
  let last = -1;
  let queued = 0;
  return async (payload, signal) => {
    // Reject malformed data before it can take a queue slot.
    signComputeStatus(payload, viewer, key);
    if (queued >= 4) throw new Error("Compute publication queue full");
    queued++;
    const previous = tail;
    let release;
    tail = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      signal.throwIfAborted();
      const until = (last + 1) * 1000;
      if (now() < until) await wait(until - now(), undefined, { signal });
      signal.throwIfAborted();
      const event = signComputeStatus(payload, viewer, key);
      if (event.created_at <= last)
        throw new Error("Compute publication clock did not advance");
      last = event.created_at;
      return event;
    } finally {
      queued--;
      release();
    }
  };
}

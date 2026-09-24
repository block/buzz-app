import { createHmac } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { getPublicKey, nip44 } from "nostr-tools";
import { eventDto } from "../src/features/relay/events.ts";
import {
  memoryAgent,
  MEMORY_EVENT_LIMIT,
  MEMORY_TEXT_BYTES,
} from "../src/features/agents/memory.ts";

/** No owner, relay, filter or budget is caller-selectable. */
export function memoryFilter(body, viewer) {
  if (
    !body ||
    Object.keys(body).length !== 1 ||
    !memoryAgent(body.agent, viewer)
  )
    throw new Error("Invalid memory target");
  return [
    {
      kinds: [30174],
      authors: [body.agent],
      "#p": [viewer],
      limit: MEMORY_EVENT_LIMIT,
    },
  ];
}

// JSON.parse validates grammar; the token walk additionally rejects duplicate names
// at every nesting depth, including escaped spellings and unknown body fields.
function uniqueJson(text) {
  const value = JSON.parse(text);
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]/g) ?? [];
  const stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "{") stack.push(new Set());
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ":") {
      const names = stack.at(-1);
      const name = JSON.parse(token);
      if (!names || names.has(name)) throw new Error("Duplicate memory field");
      names.add(name);
    }
  }
  return value;
}

/** Verified NIP-AE only; no keys or arbitrary decrypted payloads cross the host. */
export async function decodeAgentMemory(events, secret, viewer, agent, signal) {
  if (getPublicKey(secret) !== viewer || !memoryAgent(agent, viewer))
    throw new Error("Memory viewer changed");
  if (!Array.isArray(events) || events.length > MEMORY_EVENT_LIMIT)
    throw new Error("Memory event budget exceeded");
  const key = nip44.v2.utils.getConversationKey(secret, agent);
  const heads = new Map();
  let partial = events.length === MEMORY_EVENT_LIMIT;
  let bytes = 0;
  try {
    for (let i = 0; i < events.length; i++) {
      if (i % 8 === 0) await setImmediate(undefined, { signal });
      signal.throwIfAborted();
      let event, body, d;
      try {
        event = eventDto(events[i]);
        const ds = event.tags.filter(([name]) => name === "d");
        const ps = event.tags.filter(([name]) => name === "p");
        d = ds[0]?.[1];
        if (
          event.kind !== 30174 ||
          event.pubkey !== agent ||
          ds.length !== 1 ||
          ps.length !== 1 ||
          ps[0][1] !== viewer ||
          !/^[0-9a-f]{64}$/.test(d ?? "") ||
          event.content.length > 87472
        )
          throw new Error("Invalid memory envelope");
        const text = nip44.v2.decrypt(event.content, key);
        body = uniqueJson(text);
        const slug = body?.slug;
        if (
          typeof slug !== "string" ||
          slug.length > 255 ||
          (slug !== "core" &&
            !/^mem\/[a-z0-9][a-z0-9_-]{0,63}(\/[a-z0-9][a-z0-9_-]{0,63})*$/.test(
              slug,
            ))
        )
          throw new Error("Invalid memory slug");
        const expected = createHmac("sha256", key)
          .update("agent-memory/v1/d-tag\0")
          .update(slug)
          .digest("hex");
        if (
          d !== expected ||
          (slug === "core"
            ? typeof body.profile !== "string"
            : body.value !== null && typeof body.value !== "string")
        )
          throw new Error("Invalid memory body");
      } catch {
        partial = true;
        continue;
      }
      const previous = heads.get(d);
      if (
        previous &&
        (previous.createdAt > event.created_at ||
          (previous.createdAt === event.created_at &&
            previous.eventId <= event.id))
      )
        continue;
      const entry = {
        slug: body.slug,
        body: body.slug === "core" ? body.profile : body.value,
        eventId: event.id,
        createdAt: event.created_at,
      };
      bytes +=
        Buffer.byteLength(JSON.stringify(entry)) -
        (previous ? Buffer.byteLength(JSON.stringify(previous)) : 0);
      if (bytes > MEMORY_TEXT_BYTES)
        throw new Error("Decoded memory budget exceeded");
      heads.set(d, entry);
    }
    return {
      entries: [...heads.values()]
        .filter((entry) => entry.body !== null)
        .sort((a, b) => a.slug.localeCompare(b.slug)),
      partial,
    };
  } finally {
    key.fill(0);
  }
}

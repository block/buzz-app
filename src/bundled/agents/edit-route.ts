import type { JsonValue } from "../../features/navigation/targets";

/** A public identity is an address; the native snapshot supplies the exact edit record. */
export function editAgentRoute(params: JsonValue): string | null {
  if (!params || typeof params !== "object" || Array.isArray(params))
    return null;
  const keys = Object.keys(params);
  if (keys.length !== 1 || keys[0] !== "pubkey") return null;
  const pubkey = (params as { readonly pubkey: JsonValue }).pubkey;
  return typeof pubkey === "string" && /^[0-9a-f]{64}$/.test(pubkey)
    ? pubkey
    : null;
}

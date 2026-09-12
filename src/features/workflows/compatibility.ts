import { relayOrigin } from "../communities/destination.ts";
import { record } from "./protocol.ts";
import { workflowReadText } from "./http.ts";

/** HTTPS-origin evidence only; contact keys, kind lists and software versions never qualify. */
export function workflowLifecycleVersion(
  info: unknown,
  origin: string,
  expectedAuthor?: string,
): 1 | undefined {
  if (
    !record(info) ||
    typeof info.self !== "string" ||
    !/^[0-9a-f]{64}$/.test(info.self) ||
    (expectedAuthor !== undefined && info.self !== expectedAuthor) ||
    !Array.isArray(info.supported_extensions) ||
    !info.supported_extensions.includes("buzz-workflows") ||
    !record(info.workflows) ||
    info.workflows.lifecycle !== 1
  )
    return undefined;
  try {
    return info.workflows.host === new URL(relayOrigin(origin)).host
      ? 1
      : undefined;
  } catch {
    return undefined;
  }
}

/** One bounded, unsigned NIP-11 GET to the captured origin; no redirects or credential forwarding. */
export async function discoverWorkflowLifecycle(
  origin: string,
  author: string,
  signal?: AbortSignal,
): Promise<1 | undefined> {
  try {
    const response = await fetch(origin, {
      headers: { Accept: "application/nostr+json" },
      redirect: "error",
      credentials: "omit",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    });
    if (!response.ok) return undefined;
    return workflowLifecycleVersion(
      JSON.parse(await workflowReadText(response)),
      origin,
      author,
    );
  } catch {
    // Metadata failure cannot grant writes or prevent ordinary history access.
    return undefined;
  }
}

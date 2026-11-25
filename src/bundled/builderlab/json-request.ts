import type { HostResponse } from "../../features/host/service";
import type { BuilderlabSession, Credential } from "./session";

/** A status outside the route's contract: another client error is a refusal
 * of the request as sent, while a timeout, a rate limit or a server error is
 * a failure to retry. A 401 refuses only this request: the native session
 * decides when it ends. */
export function unexpected(status: number): {
  kind: "rejected";
  status: number;
} {
  if (status >= 400 && status < 500 && status !== 408 && status !== 429)
    return { kind: "rejected", status };
  throw Object.assign(
    new Error(`Builderlab request failed (HTTP ${status}).`),
    { status },
  );
}

function check(
  session: BuilderlabSession,
  credential: Credential,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (
    session.snapshot().status !== "signed-in" ||
    session.credential() !== credential
  )
    throw new DOMException("Builderlab session changed.", "AbortError");
}

/** Posts under the current credential and parses the body on every status:
 * the service answers its refusals in JSON, while the framework's own
 * refusals are plain text. `value` is absent when the body is not a JSON
 * object, which a refusal's status still explains and a success does not. */
export async function postJson(
  session: BuilderlabSession,
  path: string,
  body: unknown,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const credential = session.credential();
  let response: HostResponse;
  try {
    response = await session.request(credential, {
      path,
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    check(session, credential, signal);
    throw new Error("Couldn’t reach Builderlab.");
  }
  check(session, credential, signal);
  let value: unknown;
  try {
    value = JSON.parse(response.body);
  } catch {
    /* A plain-text framework refusal; the status carries the meaning. */
  }
  return {
    status: response.status,
    value:
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined,
  };
}

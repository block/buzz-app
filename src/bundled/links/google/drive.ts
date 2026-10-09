import type { Host } from "../../../features/host/service";
import type { OAuthSession } from "../../../shared/oauth/session";
import { DRIVE_API, type GoogleCredential } from "./oauth";

const FILE_ID = /^[\w-]{10,128}$/;
const MAX_ENTRIES = 1000;
const MAX_CONCURRENT = 4;
const MAX_TITLE_CHARACTERS = 100;

const validId = (id: string | null | undefined) =>
  id && FILE_ID.test(id) ? id : undefined;

/** The Drive file addressed by a Docs, Sheets, Slides, Forms or Drive URL. */
export function driveFileId(href: string) {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  const segments = url.pathname.split("/").filter(Boolean);
  // Signed-in account selectors (`/u/<n>/`) precede the resource on both hosts.
  const selector = segments.findIndex(
    (segment, index) =>
      segment === "u" && /^\d+$/.test(segments[index + 1] ?? ""),
  );
  if (selector !== -1) segments.splice(selector, 2);
  if (url.hostname === "docs.google.com")
    return segments[1] === "d" ? validId(segments[2]) : undefined;
  if (url.hostname !== "drive.google.com") return undefined;
  if (segments[0] === "open") return validId(url.searchParams.get("id"));
  if (segments[0] === "file" && segments[1] === "d")
    return validId(segments[2]);
  if (segments[0] === "drive" && segments[1] === "folders")
    return validId(segments[2]);
  return undefined;
}

/** One line, bounded for inline display; empty names fall back to the destination. */
export function displayTitle(name: string) {
  const text = name.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const characters = Array.from(text);
  return characters.length > MAX_TITLE_CHARACTERS
    ? `${characters.slice(0, MAX_TITLE_CHARACTERS - 1).join("")}…`
    : text;
}

/** The credential can no longer produce a token; the account must sign in again. */
class TokenError extends Error {}

/**
 * A name, `null` for files this account cannot read (cached for the sign-in),
 * or `undefined` for a transient failure that a later mount may retry.
 */
async function fetchTitle(
  host: Host,
  credential: GoogleCredential,
  id: string,
  current: () => boolean,
): Promise<string | null | undefined> {
  const token = async (force?: boolean) => {
    try {
      return await credential.token(force);
    } catch (error) {
      throw new TokenError(
        error instanceof Error ? error.message : "Google sign-in expired.",
      );
    }
  };
  const get = async (bearer: string) =>
    host.request({
      url: `${DRIVE_API}/files/${encodeURIComponent(id)}?fields=name&supportsAllDrives=true`,
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${bearer}`,
      },
    });
  let response = await get(await token());
  // A retired credential must not renew itself after sign-out.
  if (response.status === 401 && current())
    response = await get(await token(true));
  if (response.status === 200) {
    try {
      const name: unknown = JSON.parse(response.body)?.name;
      return typeof name === "string" ? displayTitle(name) : null;
    } catch {
      return null;
    }
  }
  return response.status >= 400 &&
    response.status < 500 &&
    response.status !== 429
    ? null
    : undefined;
}

/**
 * Names of Drive files the signed-in account can read, resolved once per file
 * for one credential. Unreadable files stay unresolved until the next sign-in;
 * a credential that can no longer renew signs the session out.
 */
export function createDriveTitles(
  host: Host,
  session: OAuthSession<GoogleCredential>,
) {
  const entries = new Map<string, string | null>();
  const queue = new Set<string>();
  const active = new Map<string, GoogleCredential>();
  const listeners = new Set<() => void>();
  let revision = 0;
  const publish = () => {
    for (const listener of listeners) listener();
  };
  const credential = () => {
    try {
      return session.credential();
    } catch {
      return undefined;
    }
  };
  const settle = (
    owner: GoogleCredential,
    id: string,
    title: string | null | undefined,
  ) => {
    if (active.get(id) === owner) active.delete(id);
    // A result for a retired credential must not label links for the next account.
    if (credential() === owner && title !== undefined) {
      if (entries.size >= MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(id, title);
      publish();
    }
    pump();
  };
  const pump = () => {
    for (const id of queue) {
      if (active.size >= MAX_CONCURRENT) return;
      queue.delete(id);
      const owner = credential();
      if (!owner) {
        queue.clear();
        return;
      }
      if (entries.has(id) || active.get(id) === owner) continue;
      active.set(id, owner);
      const current = () => credential() === owner;
      fetchTitle(host, owner, id, current).then(
        (title) => settle(owner, id, title),
        (error) => {
          if (error instanceof TokenError && current()) session.signOut();
          settle(owner, id, undefined);
        },
      );
    }
  };
  const unsubscribe = session.subscribe(() => {
    revision++;
    entries.clear();
    queue.clear();
    publish();
  });
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Changes whenever the account changes; mounted links re-request names then. */
    revision: () => revision,
    title(href: string) {
      const id = driveFileId(href);
      return id ? (entries.get(id) ?? undefined) : undefined;
    },
    ensure(href: string) {
      const id = driveFileId(href);
      const owner = credential();
      if (!id || !owner || entries.has(id) || active.get(id) === owner) return;
      queue.add(id);
      pump();
    },
    dispose() {
      unsubscribe();
      entries.clear();
      queue.clear();
      listeners.clear();
    },
  };
}
export type DriveTitles = ReturnType<typeof createDriveTitles>;

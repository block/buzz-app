// Where tasks live, for presentation only: each home's name and kind, and
// the project it is filed in. Read from relay-signed channel metadata
// (kind 39000) by naming each channel, so places the viewer reads through a
// project resolve too. A place the viewer can't read stays unnamed. None of
// this decides access; the relay does.
import { channelIdentity } from "../../features/relay/channel-labels";
import { metadataName } from "../../features/relay/discovery";
import { tag, type RelayEvent } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import { soloLabels } from "../../features/solo/labels";
import { channelVisibility } from "../../features/relay/channel-details-protocol";
import { huddleParent } from "../../features/huddle/lifecycle";
import { isChannelId, isPubkey, type Task } from "./model";

export type Place = Readonly<{
  id: string;
  name: string;
  kind: "chat" | "channel";
  /** The channel it is filed under (NIP-29 `parent`), if any. */
  parent?: string | undefined;
  /** What it takes from the places above it (`parent_access`): `guest`
   * lets their people read but not post, `none` shuts them out. */
  parentAccess?: "guest" | "none" | undefined;
  /** The relay's channel type (`stream`, `forum`, `dm`, …). */
  type?: string | undefined;
  huddle?: true | undefined;
  archived?: true | undefined;
}>;

/** The one rule for where a task can live, for the screens and the agent
 * tools alike: a project, channel or chat that isn't archived. Never a DM or
 * a huddle, where a task could get no comments and no place in Tasks. */
export const canHoldTasks = (
  place: Readonly<{
    type?: string | undefined;
    huddle?: true | undefined;
    archived?: true | undefined;
  }>,
) =>
  !place.archived &&
  !place.huddle &&
  (place.type === "stream" || place.type === "forum" || place.type === "solo");

/** A project as the Tasks page groups by it. `name` is undefined for a
 * project the viewer can't read. */
export type ProjectGroup = Readonly<{
  id: string | undefined;
  name: string | undefined;
}>;

const METADATA_LIMIT = 500;

function placeOf(event: RelayEvent): Place | undefined {
  const id = tag(event, "d");
  if (!isChannelId(id)) return undefined;
  const parent = tag(event, "parent");
  const { type, labels } = channelIdentity(event);
  return {
    id,
    name: metadataName(event) ?? id.slice(0, 8),
    kind: soloLabels(labels) ? "chat" : "channel",
    ...(type ? { type } : {}),
    // As discovery tells a huddle's room: private, named for its parent.
    ...(channelVisibility(event) === "private" &&
    huddleParent(tag(event, "about"))
      ? { huddle: true as const }
      : {}),
    ...(event.tags.some(
      ([name, value]) => name === "archived" && value === "true",
    )
      ? { archived: true as const }
      : {}),
    ...(isChannelId(parent) ? { parent } : {}),
    ...parentAccessOf(event),
  };
}

function parentAccessOf(event: RelayEvent): Pick<Place, "parentAccess"> {
  const value = tag(event, "parent_access");
  return value === "guest" || value === "none" ? { parentAccess: value } : {};
}

/** A place other places are filed under. */
export const isProject = (id: string, places: ReadonlyMap<string, Place>) =>
  [...places.values()].some((place) => place.parent === id);

/** One name for a place everywhere: a project as "Buzz", a chat by its
 * name, any other channel as "#random". */
export function placeLabel(
  place: Pick<Place, "id" | "name" | "kind">,
  places: ReadonlyMap<string, Place>,
) {
  return place.kind === "chat" || isProject(place.id, places)
    ? place.name
    : `#${place.name}`;
}

/** People to offer for a task in `home`: the members of it and of the
 * places it is seen from, as far as the viewer can read their relay-signed
 * rosters. A list of names only; who of them can see `home` is the relay's
 * answer, from {@link whoCanRead}. */
export async function readMembers(
  session: Pick<RelaySession, "snapshotRead" | "relayAuthor">,
  home: string,
  signal: AbortSignal,
): Promise<ReadonlySet<string>> {
  const read = session.snapshotRead;
  const author = session.relayAuthor;
  if (!read || !author) return new Set();
  const chain = seenFrom(home, await readPlaces(session, [home], signal));
  const rosters = await read(
    [{ kinds: [39002], authors: [author], "#d": chain, limit: chain.length }],
    { signal },
  );
  const people = new Set<string>();
  for (const roster of rosters)
    if (roster.pubkey === author && chain.includes(tag(roster, "d") ?? ""))
      for (const [name, value] of roster.tags)
        if (name === "p" && isPubkey(value)) people.add(value);
  return people;
}

/** The relay's answer to which of `pubkeys` can see `place`, or undefined
 * when there is none: an older relay, a refusal or a failure. Undefined
 * means the app doesn't know, so it flags and unassigns nobody, and the
 * relay's own check catches a real problem at save time. */
export async function whoCanRead(
  session: Pick<RelaySession, "channelReaders">,
  place: string,
  pubkeys: readonly string[],
  signal: AbortSignal,
): Promise<ReadonlyMap<string, boolean> | undefined> {
  if (!pubkeys.length) return new Map();
  try {
    return await session.channelReaders?.(place, pubkeys, signal);
  } catch (reason) {
    signal.throwIfAborted();
    console.warn("Couldn’t ask the relay who can see a place:", reason);
    return undefined;
  }
}

/** The places named by `ids`, and the projects they are filed in. This
 * loads one parent level, which is all nesting goes today; a deeper place
 * resolves as if shut off above that level, so access fails closed. Extend
 * it if nesting gets deeper. */
export async function readPlaces(
  session: Pick<RelaySession, "snapshotRead" | "relayAuthor">,
  ids: Iterable<string>,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, Place>> {
  const read = session.snapshotRead;
  const author = session.relayAuthor;
  const places = new Map<string, Place>();
  if (!read || !author) return places;
  const fetch = async (wanted: readonly string[]) => {
    for (let at = 0; at < wanted.length; at += METADATA_LIMIT) {
      const page = wanted.slice(at, at + METADATA_LIMIT);
      const events = await read(
        [{ kinds: [39000], authors: [author], "#d": page, limit: page.length }],
        { signal },
      );
      for (const event of events) {
        const place = event.pubkey === author ? placeOf(event) : undefined;
        if (place && page.includes(place.id)) places.set(place.id, place);
      }
    }
  };
  await fetch([...new Set(ids)]);
  const parents = [...places.values()].flatMap((place) =>
    place.parent && !places.has(place.parent) ? [place.parent] : [],
  );
  await fetch([...new Set(parents)]);
  return places;
}

/** The project `task` is in: its home's parent, or its home when other
 * places are filed under it. A home neither filed nor holding anything is
 * in no project. */
export function projectOf(
  task: Task,
  places: ReadonlyMap<string, Place>,
): ProjectGroup {
  const home = places.get(task.home);
  if (home?.parent)
    return { id: home.parent, name: places.get(home.parent)?.name };
  const holds = [...places.values()].some(
    (place) => place.parent === task.home,
  );
  return holds
    ? { id: task.home, name: home?.name }
    : { id: undefined, name: undefined };
}

/** The places whose people can see what lives in `id`: itself, then each
 * place it is filed under, as far as `parent_access` lets them in. A place
 * set to `none` keeps everyone above it out, as the relay does. */
function seenFrom(id: string, places: ReadonlyMap<string, Place>) {
  const chain = [id];
  for (let place = places.get(id); place?.parentAccess !== "none"; ) {
    const parent = place?.parent;
    if (!parent || chain.includes(parent)) break;
    chain.push(parent);
    place = places.get(parent);
  }
  return chain;
}

/** Whose access a move from `from` to `to` changes, by place: the people of
 * `gain` start seeing the task, and those of `lose` stop, unless they also
 * belong to a place in `gain`'s chain. Named places only, never people. */
export function accessChange(
  from: string,
  to: string,
  places: ReadonlyMap<string, Place>,
): Readonly<{ gain: readonly Place[]; lose: readonly Place[] }> {
  const before = seenFrom(from, places);
  const after = seenFrom(to, places);
  const named = (ids: readonly string[]) =>
    ids.flatMap((id) => places.get(id) ?? []);
  return {
    gain: named(after.filter((id) => !before.includes(id))),
    lose: named(before.filter((id) => !after.includes(id))),
  };
}

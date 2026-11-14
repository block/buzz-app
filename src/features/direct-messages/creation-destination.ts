import { readView, writeView } from "../../shared/view-state";
import type { Recipient } from "./usePeople";

export type CreationDestination =
  | { kind: "channel"; channelId: string }
  | { kind: "people"; people: Recipient[] };
export const creationDestinationKey = "direct-message:destination:v1";

/** One atomic destination; legacy keys are read only during migration. */
export function readCreationDestination(
  scope: string,
  viewer: string | undefined,
  allowChannels: boolean,
  fallback: CreationDestination = { kind: "people", people: [] },
): CreationDestination {
  const saved = readView<unknown>(scope, creationDestinationKey, null);
  if (saved && typeof saved === "object" && "kind" in saved) {
    if (
      saved.kind === "channel" &&
      "channelId" in saved &&
      typeof saved.channelId === "string"
    )
      return allowChannels
        ? { kind: "channel", channelId: saved.channelId }
        : { kind: "people", people: [] };
    if (saved.kind === "people" && "people" in saved)
      return { kind: "people", people: creationPeople(saved.people, viewer) };
  }
  const channelId = allowChannels
    ? readView<unknown>(
        scope,
        "direct-message:channel",
        fallback.kind === "channel" ? fallback.channelId : null,
      )
    : null;
  return typeof channelId === "string"
    ? { kind: "channel", channelId }
    : {
        kind: "people",
        people: creationPeople(
          readView(
            scope,
            "direct-message:recipients",
            fallback.kind === "people" ? fallback.people : [],
          ),
          viewer,
        ),
      };
}
export function creationPeople(value: unknown, viewer?: string): Recipient[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Map(
      value.flatMap((person) =>
        person &&
        typeof person.pubkey === "string" &&
        /^[0-9a-f]{64}$/.test(person.pubkey) &&
        person.pubkey !== viewer &&
        typeof person.name === "string"
          ? [
              [
                person.pubkey,
                {
                  pubkey: person.pubkey,
                  name: person.name.slice(0, 500),
                  ...(person.isAgent === true && { isAgent: true as const }),
                },
              ] as const,
            ]
          : [],
      ),
    ).values(),
  ].slice(0, 8);
}
export function saveCreationDestination(
  scope: string,
  destination: CreationDestination,
) {
  return writeView(
    scope,
    creationDestinationKey,
    destination.kind === "channel"
      ? destination
      : {
          kind: "people",
          people: destination.people.map(({ pubkey, name, isAgent }) => ({
            pubkey,
            name: name.slice(0, 500),
            ...(isAgent === true && { isAgent: true }),
          })),
        },
  );
}

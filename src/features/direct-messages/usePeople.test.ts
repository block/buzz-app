// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import { usePeople } from "./usePeople";

it("keeps a person found earlier when a longer query matches only their verified name", async () => {
  // Found by a verified name alone, and already named in the shared profiles.
  const unnamed = {
    pubkey: "a".repeat(64),
    name: "a".repeat(10),
    nameIsFallback: true as const,
  };
  const shared = new Map([
    [
      unnamed.pubkey,
      { verified: { displayName: "Aleksandr", fullName: "Aleksandr Petrov" } },
    ],
  ]);
  // The search for `petrov` fails, so only the page for `pet` can offer them.
  const people = vi.fn(async (query: string) => {
    if (query === "petrov") throw new Error("Offline");
    return { people: query ? [unnamed] : [], hasMore: false };
  });
  const session = {
    directMessages: { people },
    profiles: { snapshot: () => shared },
  } as unknown as RelaySession;
  const { result, rerender } = renderHook(
    ({ query }) => usePeople(session, query),
    { initialProps: { query: "pet" } },
  );
  await waitFor(() => expect(result.current.people).toEqual([unnamed]));
  rerender({ query: "petrov" });
  expect(result.current.people).toEqual([unnamed]);
  await waitFor(() => expect(result.current.error).toBe("Offline"));
  expect(result.current.people).toEqual([unnamed]);
});

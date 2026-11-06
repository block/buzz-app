import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SoloRegionBinding } from "../channel-navigation/solo-navigation-contract";
import {
  repositoriesFolder,
  repositoryFolders,
  type RepositoryFolder,
} from "../communities/repositories";

type Listing = Readonly<{ rows: readonly RepositoryFolder[]; error?: string }>;
type Held = {
  key: string;
  controller: AbortController;
  listing: Promise<Listing>;
  holders: number;
};
let last: Held | undefined;

function retire(held: Held) {
  held.controller.abort();
  if (last === held) last = undefined;
}

function hold(binding: SoloRegionBinding, key: string) {
  if (last?.key !== key) {
    // A new `@` query retires the previous one's listing.
    if (last) retire(last);
    const controller = new AbortController();
    const listing = repositoryFolders(
      binding.scope,
      controller.signal,
      (path) =>
        invoke<readonly RepositoryFolder[]>("repositories_folder_list", {
          path,
        }),
    ).then(
      (rows) => ({ rows }),
      (reason: unknown) => ({
        rows: [],
        error: reason instanceof Error ? reason.message : String(reason),
      }),
    );
    last = { key, controller, listing, holders: 0 };
  }
  last.holders += 1;
  return last;
}

function release(held: Held) {
  held.holders -= 1;
  // A keystroke remounts the provider in the same commit, so its next mount
  // holds the listing before this runs. A closed query has no holder by then.
  queueMicrotask(() => {
    if (!held.holders) retire(held);
  });
}

function preference(scope: string) {
  try {
    return repositoriesFolder(scope);
  } catch {
    // The listing reports why the folder cannot be read.
    return "";
  }
}

/** The task community's repositories folders for one open `@` query, listed
 * once however often the host remounts its completion. Reopening the query,
 * a changed preference or `retry` lists them again. Desktop only; elsewhere
 * there are none. */
export function useTaskFolders(
  binding: SoloRegionBinding | undefined,
  lifetime: string,
) {
  const key = binding
    ? JSON.stringify([
        binding.scope,
        binding.incarnation,
        lifetime,
        preference(binding.scope),
      ])
    : "";
  const [attempt, setAttempt] = useState(0);
  const [listed, setListed] = useState<{
    key: string;
    attempt: number;
    listing: Listing;
  }>();
  useEffect(() => {
    if (!binding || !isTauri()) return;
    let live = true;
    const held = hold(binding, key);
    void held.listing.then((listing) => {
      if (live) setListed({ key, attempt, listing });
    });
    return () => {
      live = false;
      release(held);
    };
  }, [binding, key, attempt]);
  const retry = useCallback(() => {
    if (last?.key === key) retire(last);
    setAttempt((value) => value + 1);
  }, [key]);
  const listing =
    listed?.key === key && listed.attempt === attempt
      ? listed.listing
      : undefined;
  return useMemo(() => listing && { ...listing, retry }, [listing, retry]);
}

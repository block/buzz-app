// The link between the screens' page and the page that runs agents, beside
// the Manager's and the Runner's: what the screens' page has that the agents
// page follows, and the local work the agents page shows back.
import type { FollowedCommunities } from "../communities/page";
import type { Json, Link, Served } from "./link";

/** What the screens' page tells the agents page. */
export type PageState = Readonly<{
  /** Where agent storage is: the device's files, which the screens' page
   * loaded first, or localStorage, which both pages share. */
  storage: "files" | "local";
  communities: FollowedCommunities;
}>;

/** The screens' page's side: `state` once it has it, then each change. */
export function servePage(
  state: Readonly<{
    snapshot(): PageState | undefined;
    subscribe(listener: () => void): () => void;
  }>,
): Served {
  return {
    topics: {
      "page.state": () => ({
        get: () => (state.snapshot() ?? null) as Json,
        subscribe: state.subscribe,
      }),
    },
  };
}

/** The agents page's side: hears each state the screens' page sends, from
 * the first. */
export function followPage(page: Link, listener: (state: PageState) => void) {
  return page.watch("page.state", null, () => {
    const state = page.read("page.state") as PageState | null | undefined;
    if (state) listener(state);
  });
}

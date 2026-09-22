import type { Context } from "@buzz/author";
import { createApp } from "./App";
import { createPreferencesStore } from "./preferences";
import { createTokenStore } from "./tokenStore";
import { fetchReviewRequests, fetchOwnPullRequests } from "./github";
import { createQueueCache } from "./queueCache";

export const inject = ["react", "pages", "relay"];

export function apply(ctx: Context) {
  const tokenStore = createTokenStore();
  ctx.effect(() => tokenStore.dispose);
  const preferencesStore = createPreferencesStore();
  const queues = {
    reviewRequests: createQueueCache(
      tokenStore,
      fetchReviewRequests,
      "Could not load review requests.",
    ),
    ownPullRequests: createQueueCache(
      tokenStore,
      fetchOwnPullRequests,
      "Could not load your pull requests.",
    ),
  };
  ctx.effect(() => () => {
    queues.reviewRequests.dispose();
    queues.ownPullRequests.dispose();
  });
  const App = createApp(
    ctx.react,
    tokenStore,
    preferencesStore,
    ctx.relay,
    queues,
  );
  ctx.pages.register({ id: "main", title: "PR Beacon", component: App });
}

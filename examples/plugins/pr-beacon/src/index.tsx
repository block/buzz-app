import type { Context } from "@buzz/author";
import { createApp } from "./App";
import { createPreferencesStore } from "./preferences";
import { createTokenStore } from "./tokenStore";

export const inject = ["react", "pages", "relay"];

export function apply(ctx: Context) {
  const tokenStore = createTokenStore();
  ctx.effect(() => tokenStore.dispose);
  const preferencesStore = createPreferencesStore();
  const App = createApp(ctx.react, tokenStore, preferencesStore, ctx.relay);
  ctx.pages.register({ id: "main", title: "PR Beacon", component: App });
}

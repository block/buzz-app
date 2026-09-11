import type { Context } from "@deepseek-ai/cordis";
import {
  createNavigationController,
  type Navigation,
  type OpenAttempt,
  type OpenResult,
} from "./controller";
import { createBrowserHistory } from "./browser-history";
import { createMemoryHistory } from "./history";
import type { JsonValue, OpenTarget } from "./targets";

export type PageNavigation = Readonly<{
  entryId: string;
  target: OpenTarget;
  signal: AbortSignal;
  complete(
    result: Extract<OpenResult, { status: "opened" | "failed" }>,
  ): boolean;
}>;
declare module "@deepseek-ai/cordis" {
  interface Context {
    navigation: Navigation;
  }
}
export function provideNavigation(
  ctx: Context,
  host = typeof window === "undefined" ? undefined : window,
) {
  const controller = createNavigationController(
    host ? createBrowserHistory(host) : createMemoryHistory(),
  );
  ctx.provide("navigation", controller.navigation);
  const positions = new Map<string, JsonValue>();
  ctx.effect(() => () => {
    controller.dispose();
    positions.clear();
  });
  return {
    ...controller,
    /** Bounded per-visit state; never drafts, message bodies, credentials or authorization. */
    position(id: string) {
      return positions.get(id);
    },
    savePosition(id: string, value: JsonValue) {
      positions.delete(id);
      positions.set(id, value);
      while (positions.size > 100) {
        const first = positions.keys().next().value;
        if (first) positions.delete(first);
      }
    },
    request(attempt: OpenAttempt): PageNavigation {
      return Object.freeze({
        entryId: attempt.entry.id,
        target: attempt.entry.target,
        signal: attempt.signal,
        complete: (result) => controller.complete(attempt, result),
      });
    },
  };
}

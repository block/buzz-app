// `ctx.finder`: other plugins open Finder on a list, or add lists of their
// own. Finder provides it while it's on; take it with
// `ctx.inject(["finder"], (child) => …)` so a plugin still starts without it.
import { type Context, Service } from "@deepseek-ai/cordis";
import type { ComponentType } from "react";
import type { ChatCircleIcon } from "../../shared/design-system/icons/index";
import {
  type Contribution,
  createContributions,
} from "../../plugins/contributions";

/** One row in a source's list. */
export type FinderItem = Readonly<{
  id: string;
  /** What's shown and matched. */
  label: string;
  /** A second line, such as where it is. */
  detail?: string;
  /** Matched too, but not shown, such as a handle. */
  keywords?: string;
  icon?: typeof ChatCircleIcon;
  avatar?: Readonly<{
    src?: string | undefined;
    name?: string;
    shape?: "circle" | "squircle";
  }>;
  /** Shown beside the list while the row is highlighted. */
  preview?:
    | Readonly<{ kind: "channel"; channelId: string }>
    | Readonly<{ kind: "person"; pubkey: string }>
    | ComponentType;
  /** Runs on Enter or click, after Finder closes. */
  run(): void;
}>;

export type FinderSource = Readonly<
  {
    /** Unique within your plugin; Finder prefixes your plugin's ID. */
    id: string;
    /** Names the list, in the scope chip. */
    title: string;
  } & (
    | {
        /** Every row; Finder ranks them as you type. */
        items(): readonly FinderItem[];
      }
    | {
        /** Your own search, for each text typed. Publish as often as rows
         * change; publishing after `signal` aborts does nothing. */
        search(
          query: string,
          publish: (items: readonly FinderItem[]) => void,
          signal: AbortSignal,
        ): void;
      }
  )
>;

export type FinderOpenOptions = Readonly<{
  /** A source key, such as "buzz.finder/people" or "your.plugin/id".
   * Without it, Finder opens as ⌘P does. */
  source?: string;
  /** The text to start with. Without it, the field starts empty. */
  query?: string;
}>;

export type Finder = {
  /** Adds a source; returns a function that removes it. It also goes when
   * your plugin stops. */
  registerSource(source: FinderSource): () => void;
  open(options?: FinderOpenOptions): void;
};

export type RegisteredSource = Contribution<FinderSource>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Present while the Finder plugin is on. */
    finder?: Finder;
  }
}

/** Provides `ctx.finder` for as long as `ctx` (Finder's own scope) lives. */
export function provideFinder(
  ctx: Context,
  open: (options: FinderOpenOptions) => void,
) {
  const sources = createContributions<FinderSource>(ctx);
  class FinderService extends Service implements Finder {
    constructor() {
      super(ctx, "finder");
    }
    // Methods, so Cordis supplies the caller's context for the source's
    // owner and lifetime.
    registerSource(source: FinderSource) {
      return sources.register(this.ctx, source);
    }
    open(options: FinderOpenOptions = {}) {
      open(options);
    }
  }
  new FinderService();
  return sources;
}

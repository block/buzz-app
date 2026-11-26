import type { Context } from "@deepseek-ai/cordis";

/** Where focus goes when a conversation or thread opens, for plugins. */
export type Focus = Readonly<{
  /**
   * While held, opening a conversation or thread selects one of its messages
   * instead of focusing its message box: the row `pick` returns for the list,
   * or the newest. Returns a release; call it when the plugin stops, for
   * example from `ctx.effect`.
   */
  preferMessagesOnOpen(
    pick?: (list: HTMLElement) => HTMLElement | undefined,
  ): () => void;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    focus: Focus;
  }
}

type Pick = (list: HTMLElement) => HTMLElement | undefined;
const holders: { pick: Pick }[] = [];
const newest: Pick = () => undefined;
/** The latest holder's choice, or undefined when no plugin holds it. */
export const messagesOnOpen = () => holders.at(-1)?.pick;

export const focus: Focus = Object.freeze({
  preferMessagesOnOpen(pick: Pick = newest) {
    const holder = { pick };
    holders.push(holder);
    return () => {
      const index = holders.indexOf(holder);
      if (index >= 0) holders.splice(index, 1);
    };
  },
});

export function provideFocus(ctx: Context) {
  ctx.provide("focus", focus);
}

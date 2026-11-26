import type { Context } from "@deepseek-ai/cordis";

/** Where focus goes when a conversation or thread opens, for plugins. */
export type Focus = Readonly<{
  /**
   * While held, opening a conversation or thread selects its newest message
   * instead of focusing its message box. Returns a release; call it when the
   * plugin stops, for example from `ctx.effect`.
   */
  preferMessagesOnOpen(): () => void;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    focus: Focus;
  }
}

let holders = 0;
export const messagesOnOpen = () => holders > 0;

export const focus: Focus = Object.freeze({
  preferMessagesOnOpen() {
    holders++;
    let held = true;
    return () => {
      if (held) holders--;
      held = false;
    };
  },
});

export function provideFocus(ctx: Context) {
  ctx.provide("focus", focus);
}

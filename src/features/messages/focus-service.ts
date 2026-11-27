import { type Context, Service } from "@deepseek-ai/cordis";

/** Where focus goes when a conversation or thread opens, for plugins. */
export type Focus = Readonly<{
  /**
   * While held, opening a conversation or thread selects one of its messages
   * instead of focusing its message box: the row `pick` returns for the list,
   * or the newest. Buzz releases it when the plugin stops; the returned
   * function releases it sooner.
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

export class FocusService extends Service implements Focus {
  constructor(ctx: Context) {
    super(ctx, "focus");
  }
  preferMessagesOnOpen(pick: Pick = newest) {
    const holder = { pick };
    // An effect on the caller's context, so a stopped plugin lets go.
    const release = this.ctx.effect(() => {
      holders.push(holder);
      return () => {
        const index = holders.indexOf(holder);
        if (index >= 0) holders.splice(index, 1);
      };
    }, "focus.preferMessagesOnOpen");
    return () => void release();
  }
}

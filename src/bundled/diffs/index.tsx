import type { Context } from "@deepseek-ai/cordis";
import { DiffMessage } from "./DiffMessage";

export const inject = ["conversation"];
export function apply(ctx: Context) {
  ctx.conversation.registerMessage({
    id: "diff",
    title: "Code diff",
    matches: (message) => !!message.diff,
    component: DiffMessage,
  });
}

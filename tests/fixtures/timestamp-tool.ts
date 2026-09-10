// Automated external-producer fixture only; never installed by Composer Lab.
import type { Context, ComposerToolProps } from "@buzz/author";

export const inject = ["react", "conversation"];
export function apply(ctx: Context) {
  const h = ctx.react.createElement;
  ctx.conversation.registerTool({
    id: "timestamp",
    title: "Insert timestamp",
    component: ({ disabled, insertText }: ComposerToolProps) =>
      h(
        "button",
        {
          type: "button",
          disabled,
          title: "Insert timestamp",
          "aria-label": "Insert timestamp",
          onClick: () => insertText(new Date().toISOString()),
        },
        "Time",
      ),
  });
}

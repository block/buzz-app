export const inject = ["conversation"];
export function apply(ctx) {
  ctx.conversation.registerSelectionPreview({
    id: "example-id",
    title: "Example ID",
    matches: ({ text }) => /^EX-\d+$/.test(text),
    component: ({ text }) =>
      ctx.react.createElement("code", { className: "text-body-sm" }, text),
  });
}

// Host-rendered appearance; no DOM overrides, data access or private imports.
export const inject = ["conversation"];
export function apply(ctx) {
  if (typeof ctx.conversation.registerAppearance !== "function") {
    throw new Error(
      "Message bubbles requires a Buzz version with message appearance support.",
    );
  }
  ctx.conversation.registerAppearance({
    id: "bubbles",
    title: "Message bubbles",
    preset: "bubbles",
  });
}

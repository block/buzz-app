export const inject = [];

export function apply(ctx) {
  const rows = ctx.reflect.get("sidebarRows");
  if (!rows?.unreadCueModes?.includes("mentions-and-dms")) {
    throw new Error(
      "This plugin needs a Buzz version with mentions-and-DMs unread cue support.",
    );
  }
  rows.register({
    version: 1,
    id: "unread-cues",
    unreadCues: "mentions-and-dms",
  });
}

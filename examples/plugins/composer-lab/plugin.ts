import type { ChangeEvent } from "react";
import type { Context, ComposerToolProps, RelaySnapshot } from "@buzz/author";

// Type-only author contract. The installed artifact has no private paths, React
// copy, bundled Channels import, or runtime dependencies.
export const inject = ["react", "pages", "relay", "conversation"];
export function apply(ctx: Context) {
  const React = ctx.react;
  const h = React.createElement;
  const ui = ctx.conversation;
  const relay = ctx.relay;
  ui.registerTool({
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
  function Connected({ connection }: { connection: RelaySnapshot }) {
    const session = connection.session;
    const list = React.useSyncExternalStore(
      session.channels.subscribeList,
      session.channels.list,
      session.channels.list,
    );
    React.useEffect(() => session.channels.ensureList(), [session]);
    const [selected, select] = React.useState("");
    const channel =
      list.channels.find((item) => item.id === selected) ?? list.channels[0];
    return h(
      "section",
      null,
      h(
        "p",
        null,
        "This page uses the same session and composer as Channels. Sending here posts to the selected channel.",
      ),
      h(
        "label",
        null,
        "Lab channel",
        h(
          "select",
          {
            value: channel?.id ?? "",
            onChange: (event: ChangeEvent<HTMLSelectElement>) =>
              select(event.target.value),
          },
          list.channels.map((item) =>
            h("option", { key: item.id, value: item.id }, item.name),
          ),
        ),
      ),
      channel
        ? h(Conversation, {
            connection,
            channelId: channel.id,
            channelName: channel.name,
          })
        : h("p", null, list.error ?? "No channels available"),
    );
  }
  function Conversation({
    connection,
    channelId,
    channelName,
  }: {
    connection: RelaySnapshot;
    channelId: string;
    channelName: string;
  }) {
    const [renders, rerender] = React.useState(0);
    const session = connection.session;
    const subscribe = React.useCallback(
      (listener: () => void) =>
        session.channels.subscribeWindow(channelId, listener),
      [session, channelId],
    );
    const read = React.useCallback(
      () => session.channels.window(channelId),
      [session, channelId],
    );
    const window = React.useSyncExternalStore(subscribe, read, read);
    React.useEffect(
      () => session.channels.ensure(channelId),
      [session, channelId],
    );
    return h(
      "div",
      null,
      h(
        "button",
        { type: "button", onClick: () => rerender(renders + 1) },
        `Rerender Lab ${renders}`,
      ),
      h(
        "div",
        { "aria-label": "Lab messages" },
        window.rows.map((row) =>
          h(ui.ui.Message, {
            key: row.id,
            row,
            profile: undefined,
            media: session.media,
            onOpenLink: () => false,
            day: false,
            retry: session.messages.retry,
          }),
        ),
      ),
      h(ui.ui.Composer, {
        session,
        scope: connection.scope ?? "disconnected",
        channelId,
        channelName,
      }),
    );
  }
  ctx.pages.register({
    id: "main",
    title: "Composer Lab",
    component: function Lab() {
      const connection = React.useSyncExternalStore(
        relay.subscribe,
        relay.snapshot,
        relay.snapshot,
      );
      return h(
        "section",
        { "aria-label": "Composer Lab", style: { padding: 24 } },
        h("h1", null, "Composer Lab"),
        connection.status === "ready"
          ? h(Connected, {
              key: `${connection.scope}:${connection.generation}`,
              connection,
            })
          : h("p", null, "Connect to a community to try the shared composer."),
      );
    },
  });
}

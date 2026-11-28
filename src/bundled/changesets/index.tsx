import { isTauri } from "@tauri-apps/api/core";
import type { PluginModule } from "../../plugins/api";
import { createGit } from "./git";
import { createComments } from "./comments";
import { ChangesetPanel } from "./Panel";
import { TurnCards } from "./Card";
import { parseTarget } from "./target";
import { type Turn, createTurns } from "./turns";

export const inject = ["panels", "host", "conversation", "relay"];

/** Posts `text` to the agent that ran `turn`, where it ran: its thread, or
 * the chat itself. */
export function sendToAgent(
  relay: Parameters<PluginModule["apply"]>[0]["relay"],
  turn: Turn,
  text: string,
) {
  const connection = relay.snapshot();
  if (
    connection.status !== "ready" ||
    connection.origin !== turn.origin ||
    connection.session.viewer !== turn.viewer
  )
    throw new Error(
      "Switch to the community and account this changeset was recorded in, then try again.",
    );
  const { messages } = connection.session;
  if (turn.thread)
    messages.reply(turn.channelId, turn.thread, text, [turn.agent]);
  else messages.send(turn.channelId, text, [turn.agent]);
}
export const apply: PluginModule["apply"] = (ctx) => {
  const { host } = ctx;
  if (!isTauri() || !host.spawn) return;
  const turns = createTurns(createGit(host.spawn.bind(host)));
  const comments = createComments();
  ctx.effect(() => {
    let release: (() => void) | undefined;
    let bound: unknown;
    const bind = () => {
      const connection = ctx.relay.snapshot();
      const next =
        connection.status === "ready" ? connection.session : undefined;
      if (next === bound) return;
      release?.();
      bound = next;
      release = next && turns.watch(next, connection.origin);
    };
    const stop = ctx.relay.subscribe(bind);
    bind();
    return () => {
      stop();
      release?.();
      turns.flush();
    };
  });
  ctx.conversation.registerAccessory({
    id: "changes",
    title: "Changed files",
    placement: "message",
    component: (props) => <TurnCards {...props} turns={turns} />,
  });
  ctx.panels.register({
    id: "changes",
    title: "Changes",
    matches: (url) => !!parseTarget(url),
    component: ({ target }) => (
      <ChangesetPanel
        target={target}
        turns={turns}
        comments={comments}
        send={(turn, text) => sendToAgent(ctx.relay, turn, text)}
      />
    ),
  });
};

import type { AddedTool, BuzzClient } from "./host";
import {
  closeItem,
  describeScene,
  openItem,
  setDriver,
  updateItem,
  type CanvasScene,
} from "./scene";
import {
  readScene,
  saveScene,
  SceneConflict,
  type ScenePublish,
  type SceneRead,
} from "./store";
import type { CanvasViews } from "./view";

const string = (args: Record<string, unknown>, key: string) => {
  const value = args[key];
  if (typeof value !== "string" || !value)
    throw new Error(`${key} is required.`);
  return value;
};

/** The agent reads and saves the scene as itself, on its own connection, so
 * the relay applies the agent's access to the channel, not its owner's. */
export function canvasTools(
  views: CanvasViews,
  /** Shows the canvas beside the conversation when the owner is viewing it. */
  show: (channelId: string, rootId?: string) => boolean,
): AddedTool[] {
  const read =
    (client: BuzzClient): SceneRead =>
    (filters) =>
      client.query(filters as Parameters<BuzzClient["query"]>[0]);
  const publish =
    (client: BuzzClient): ScenePublish =>
    (template) =>
      client.publish(template);
  const channel = (context: { channel?: string | undefined }) => {
    if (!context.channel)
      throw new Error("There is no conversation here to hold a canvas.");
    return context.channel;
  };
  const report = (scene: CanvasScene, note?: string) =>
    JSON.stringify({ ...describeScene(scene, views), ...(note && { note }) });
  /** Applies `update` to the relay's current scene, once more on a conflict. */
  async function change(
    client: BuzzClient,
    channelId: string,
    update: (scene: CanvasScene) => CanvasScene,
    steering = false,
  ) {
    for (let attempt = 0; ; attempt++) {
      const saved = await readScene(read(client), channelId, views);
      const { driver } = saved.scene;
      if (!steering && driver && driver !== client.pubkey)
        throw new Error(
          "Someone else is driving this canvas. Call canvas_drive to take the wheel first, and only when asked to.",
        );
      try {
        client.signal?.throwIfAborted();
        return (
          await saveScene(
            publish(client),
            channelId,
            saved,
            update(saved.scene),
          )
        ).scene;
      } catch (error) {
        if (!(error instanceof SceneConflict) || attempt) throw error;
      }
    }
  }
  const tool = (
    name: string,
    description: string,
    properties: Record<string, object>,
    required: string[],
    call: AddedTool["call"],
  ): AddedTool => ({
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    call,
  });
  const str = { type: "string" };
  return [
    tool(
      "canvas_read",
      "Read this conversation's canvas: the views on it, what each shows, which is in front, who is driving and the view types you can open. You never see pixels, only this description.",
      {},
      [],
      async (client, context) =>
        report((await readScene(read(client), channel(context), views)).scene),
    ),
    tool(
      "canvas_open",
      "Open a view on this conversation's canvas and bring it to the front, for everyone following. Reusing an id replaces that view. Shows the canvas beside the conversation when your owner is viewing it.",
      {
        type: {
          ...str,
          description: "A view type from canvas_read's viewTypes.",
        },
        state: {
          type: "object",
          description:
            "What the view shows; its shape belongs to the view type. Copy it from a view of that type in canvas_read.",
        },
        title: { ...str, description: "The view's tab name." },
        id: { ...str, description: "Omit for a new view." },
      },
      ["type", "state"],
      async (client, context, args) => {
        const id = channel(context);
        const scene = await change(client, id, (current) =>
          openItem(current, views, {
            type: string(args, "type"),
            state: args.state,
            ...(typeof args.title === "string" && { title: args.title }),
            ...(typeof args.id === "string" && { id: args.id }),
          }),
        );
        return report(
          scene,
          show(id, context.root)
            ? "Shown beside the conversation."
            : "Saved. Your owner is not viewing this conversation in the desktop app now.",
        );
      },
    ),
    tool(
      "canvas_update",
      "Change what one view on the canvas shows, such as its address or position, for everyone following.",
      { id: str, state: { type: "object" } },
      ["id", "state"],
      async (client, context, args) =>
        report(
          await change(client, channel(context), (current) =>
            updateItem(current, views, string(args, "id"), args.state),
          ),
        ),
    ),
    tool(
      "canvas_close",
      "Close one view on the canvas.",
      { id: str },
      ["id"],
      async (client, context, args) =>
        report(
          await change(client, channel(context), (current) =>
            closeItem(current, string(args, "id")),
          ),
        ),
    ),
    tool(
      "canvas_drive",
      "Take the wheel of the canvas, so people following see what you open, or hand it back. Taking it from a person interrupts them: do it only when asked.",
      { drive: { type: "boolean" } },
      ["drive"],
      async (client, context, args) =>
        report(
          await change(
            client,
            channel(context),
            (current) =>
              args.drive === true
                ? setDriver(current, client.pubkey)
                : current.driver === client.pubkey
                  ? setDriver(current)
                  : current,
            true,
          ),
        ),
    ),
  ];
}

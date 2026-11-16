// A link between a task and a conversation is stored on the conversation's
// side: one NIP-AR artifact of type `buzz.task-link` whose home is the linked
// conversation. Only people who can read that conversation read the link or
// learn it exists, and linking never changes who can read either side.
import {
  ARTIFACT_KIND,
  deliver,
  uuidv5,
} from "../../features/agents/agent-config-artifacts";
import type { EventData, RelayEvent } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import { isChannelId } from "./model";

export const LINK_TYPE = "buzz.task-link";
/** Namespace for link ids, so one task and conversation have one link. */
const LINK_NAMESPACE = "6f1d0c2e-8a57-4b0e-9c43-2f6a1d9b7e15";
/** The link's title is public to the conversation; the task's is not. */
const LINK_TITLE = "Task link";
const READ_LIMIT = 500;

export type TaskLink = Readonly<{
  /** The link artifact's `d`. */
  id: string;
  task: string;
  conversation: string;
  revision: string;
}>;

const tag = (event: EventData, name: string) =>
  event.tags.find((entry) => entry[0] === name)?.[1];

export function linkOf(event: RelayEvent): TaskLink | undefined {
  if (event.kind !== ARTIFACT_KIND || tag(event, "type") !== LINK_TYPE)
    return undefined;
  const id = tag(event, "d");
  const task = tag(event, "task");
  const conversation = tag(event, "h");
  if (!isChannelId(id) || !isChannelId(task) || !isChannelId(conversation))
    return undefined;
  return { id, task, conversation, revision: event.id };
}

export const linkId = (task: string, conversation: string) =>
  uuidv5(LINK_NAMESPACE, `${task}\0${conversation}`);

/** Current links the viewer can read: of `task`, or in `conversation`. */
export async function readLinks(
  session: RelaySession,
  of: Readonly<{ task: string } | { conversation: string }>,
  signal: AbortSignal,
): Promise<readonly TaskLink[]> {
  const read = session.snapshotRead;
  if (!read) throw new Error("Tasks aren’t available in this community.");
  const events = await read(
    [
      {
        artifact: "current",
        kinds: [ARTIFACT_KIND],
        "#type": [LINK_TYPE],
        ...("task" in of
          ? { "#task": [of.task] }
          : { "#h": [of.conversation] }),
        limit: READ_LIMIT,
      },
    ],
    { signal },
  );
  return events.flatMap((event) => linkOf(event) ?? []);
}

/** The link's head, including a deletion, or undefined when it never was. */
async function head(
  session: Pick<RelaySession, "snapshotRead">,
  id: string,
  conversation: string,
  signal: AbortSignal,
) {
  const read = session.snapshotRead;
  if (!read) throw new Error("Tasks aren’t available in this community.");
  const [event] = await read(
    [
      {
        kinds: [ARTIFACT_KIND],
        "#h": [conversation],
        "#d": [id],
        limit: 1,
        consistency: "strong",
      },
    ],
    { signal },
  );
  return event && tag(event, "d") === id ? event : undefined;
}

/** Links `task` to `conversation`, or with `unlink` removes the link. Only
 * people who can post in the conversation can. Doing what is already done
 * succeeds. The link's current state is read through `reader` alone. */
export async function setLink(
  session: RelaySession,
  reader: Pick<RelaySession, "snapshotRead">,
  task: string,
  conversation: string,
  linked: boolean,
  signal: AbortSignal,
): Promise<void> {
  const writer = session.configArtifactWriter;
  if (!writer) throw new Error("This community connection can’t link tasks.");
  const id = await linkId(task, conversation);
  const current = await head(reader, id, conversation, signal);
  const deleted = !current || tag(current, "op") === "delete";
  if (deleted !== linked) return;
  const op = linked ? (current ? "restore" : "create") : "delete";
  const event = await writer.sign(
    {
      kind: ARTIFACT_KIND,
      created_at: Math.floor(Date.now() / 1000),
      content: linked ? JSON.stringify({ version: 1 }) : "",
      tags: [
        ["ar", "1"],
        ["d", id],
        ["h", conversation],
        ["type", LINK_TYPE],
        ["op", op],
        ...(current ? [["prev", current.id]] : []),
        ...(linked
          ? [
              ["title", LINK_TITLE],
              ["task", task],
            ]
          : []),
      ],
    },
    signal,
  );
  const delivery = await deliver(writer, event, signal);
  if (delivery.status === "accepted") return;
  throw new Error(
    delivery.status === "refused" && delivery.refusal === "permission"
      ? "You can only link conversations you can post in."
      : delivery.status === "refused" && delivery.refusal === "conflict"
        ? "Someone else changed this link. Try again."
        : "Couldn’t save the link. Try again.",
  );
}

// Agent tools: find, create, update and comment. An agent sees and says
// things as itself: every read goes through its own connection, so it finds
// only tasks it could read, and its comments are its own words. Saves are
// signed by its owner, the task's creator, with the agent named as "via",
// and only where the agent can read too; the relay applies the owner's
// access to them. Three rules keep agents' tidying trustworthy: create looks
// for an open task about the same thing first, Done or Cancelled needs
// evidence, commented before the task closes, and a move is previewed and
// done only once the person confirms it.
import type { Agents as AgentsService } from "../../features/agents/service";
import type { BuzzClient } from "../../buzz-mcp/client";
import type { RelaySession } from "../../features/relay/session";
import { postAgentComment } from "./conversation";
import { setLink } from "./links";
import {
  byRecent,
  checkedFields,
  imageOf,
  isChannelId,
  isPubkey,
  MAX_ASSIGNEES,
  statuses,
  statusLabels,
  type Task,
  type TaskFields,
  type TaskStatus,
} from "./model";
import {
  accessChange,
  canHoldTasks,
  type Place,
  placeLabel,
  projectOf,
  readPlaces,
  readReaders,
} from "./places";
import {
  readTask,
  readTasks,
  saveTask,
  TaskRefused,
  type TaskSource,
} from "./store";
import { holdsWords, sameness } from "./similar";

type Agents = Pick<AgentsService, "addTool" | "relay">;
type Client = Pick<BuzzClient, "key" | "pubkey" | "query" | "publish"> & {
  signal?: AbortSignal | undefined;
  relayAuthor?: string | undefined;
};
type Args = Record<string, unknown>;

/** How many times an agent's change is reapplied over someone else's edit. */
const ATTEMPTS = 3;
const LIST_LIMIT = 50;
/** How long one tool call's relay work may take. */
const STEP_TIMEOUT = 60_000;
/** How long a move preview's confirmation stays good. */
const PREVIEW_TTL = 15 * 60_000;
/** At or above: the same task. Between this and CLEAR: a person decides. */
const CLEAR_MATCH = 0.8;
const POSSIBLE_MATCH = 0.5;
const OPEN: readonly TaskStatus[] = ["todo", "in_progress"];
const CLOSED: readonly TaskStatus[] = ["done", "cancelled"];
const INCOMPLETE =
  "\n(These may not be all of them: narrow the search to see the rest.)";

const deadline = (client: Client) =>
  client.signal
    ? AbortSignal.any([client.signal, AbortSignal.timeout(STEP_TIMEOUT)])
    : AbortSignal.timeout(STEP_TIMEOUT);

/** Saves as `saveTask` does, but a refusal also carries the relay's own
 * text: an agent can act on it, where a person gets only the plain line. */
const save: typeof saveTask = (...args) =>
  saveTask(...args).catch((reason: unknown) => {
    throw reason instanceof TaskRefused
      ? new Error(`${reason.message} The relay said: ${reason.relay}`)
      : reason;
  });

/** The agent's own reads, as task reads take them. */
function agentReads(client: Client, session: RelaySession): TaskSource {
  return {
    relayAuthor: client.relayAuthor ?? session.relayAuthor,
    snapshotRead: (filters, { signal }) => {
      signal?.throwIfAborted();
      return client.query(filters as never) as never;
    },
  };
}

const statusOf = (value: unknown): TaskStatus | undefined =>
  statuses.find((status) => status === value);

const textArg = (args: Args, name: string) => {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be text`);
  return value;
};

const channelArg = (args: Args, name: string) => {
  const value = textArg(args, name);
  if (value !== undefined && !isChannelId(value))
    throw new Error(`${name} must be a channel id`);
  return value;
};

function imagesArg(args: Args) {
  if (args.images === undefined) return undefined;
  if (!Array.isArray(args.images))
    throw new Error("images must be a list of https media links");
  return args.images.map((item) => {
    const image = imageOf(typeof item === "string" ? { url: item } : item);
    if (!image) throw new Error("Each image must be an https media link");
    return image;
  });
}

function assigneesArg(args: Args) {
  if (args.assignees === undefined) return undefined;
  const list = args.assignees;
  if (!Array.isArray(list) || !list.every(isPubkey))
    throw new Error("assignees must be a list of people's hex pubkeys");
  if (list.length > MAX_ASSIGNEES)
    throw new Error(`A task has up to ${MAX_ASSIGNEES} assignees`);
  return [...new Set(list)];
}

/** Refuses anyone who isn't a known person able to see what lives in
 * `home`, rather than guessing: an agent never answers for a task. */
async function checkAssignees(
  session: RelaySession,
  reads: TaskSource,
  home: string,
  assignees: readonly string[],
  signal: AbortSignal,
) {
  if (!assignees.length) return;
  await session.profiles.ensure([...assignees], "foreground").catch(() => {});
  const profiles = session.profiles.snapshot();
  for (const pubkey of assignees) {
    const profile = profiles.get(pubkey);
    if (!profile)
      throw new Error(
        `Couldn't find a person with pubkey ${pubkey}; nobody was assigned`,
      );
    if (profile.isAgent)
      throw new Error("Only people can be assigned, never agents");
  }
  const readers = await readReaders(reads, home, signal);
  if (readers.anyone) return;
  const blind = assignees.filter((pubkey) => !readers.people.has(pubkey));
  if (blind.length)
    throw new Error(
      `${blind.map((pubkey) => nameOf(session, pubkey)).join(", ")} can't see this task, so they can't be assigned`,
    );
}

const nameOf = (session: RelaySession, pubkey: string) =>
  session.profiles.snapshot().get(pubkey)?.name ?? pubkey;

const labelOf = (id: string, places: ReadonlyMap<string, Place>) => {
  const place = places.get(id);
  return place ? placeLabel(place, places) : "a private place";
};

/** Where it lives and who can see it, in words an agent can pass on. */
function whereabouts(task: Task, places: ReadonlyMap<string, Place>) {
  const home = places.get(task.home);
  const project = projectOf(task, places);
  const place = home
    ? `${placeLabel(home, places)} (${home.kind}, ${home.id})`
    : task.home;
  const inProject =
    project.id && project.id !== task.home
      ? ` in the ${project.name ?? "private"} project`
      : "";
  return `Lives in ${place}${inProject}. Anyone who can open ${home ? placeLabel(home, places) : "that place"} can see it.`;
}

function describe(
  task: Task,
  session: RelaySession,
  places: ReadonlyMap<string, Place>,
) {
  const creator = task.creator
    ? `${nameOf(session, task.creator)}${task.via ? ` via ${nameOf(session, task.via)}` : ""}`
    : "unknown";
  return [
    `# ${task.title}`,
    `id: ${task.id}`,
    `status: ${statusLabels[task.status]}`,
    `assignees: ${task.assignees.map((pubkey) => nameOf(session, pubkey)).join(", ") || "nobody"}`,
    `created by: ${creator}`,
    `updated: ${new Date(task.updatedAt * 1000).toISOString()} by ${nameOf(session, task.editor)}`,
    whereabouts(task, places),
    "",
    task.description || "(No description.)",
    ...(task.images.length
      ? ["", "## Images", ...task.images.map((image) => `- ${image.url}`)]
      : []),
  ].join("\n");
}

const summary = (task: Task, session: RelaySession) =>
  `- ${task.id}: ${task.title} (${statusLabels[task.status]}; ${
    task.assignees.length
      ? task.assignees.map((pubkey) => nameOf(session, pubkey)).join(", ")
      : "nobody has it"
  })`;

/** A move the person was shown, good once for that revision and place. */
type Preview = Readonly<{
  task: string;
  revision: string;
  to: string;
  keep: readonly string[];
  expires: number;
}>;

export function addTaskTools(agents: Agents) {
  const previews = new Map<string, Preview>();

  /** The owner's session for this agent's community. */
  function sessionOf(client: Client) {
    const relay = agents.relay(client.key)?.snapshot();
    if (relay?.status !== "ready")
      throw new Error("Tasks need this conversation's community");
    return relay.session;
  }

  /** The task as the agent can read it; one it can't read isn't there. */
  async function current(reads: TaskSource, id: string, signal: AbortSignal) {
    const task = await readTask(reads, id, signal);
    if (!task) throw new Error(`No task ${id} that you can read`);
    return task;
  }

  /** Throws unless the agent can read place `id` and a task can live there. */
  async function readable(reads: TaskSource, id: string, signal: AbortSignal) {
    const places = await readPlaces(reads, [id], signal);
    const place = places.get(id);
    if (!place)
      throw new Error(
        "You can't see that place, so a task can't go there. Nothing changed.",
      );
    if (!canHoldTasks(place))
      throw new Error(
        "A task can live in a project, channel or chat that isn't archived, never a DM or a huddle. Ask which place it should go in. Nothing changed.",
      );
    return places;
  }

  /** Applies `edit` to the newest revision the agent can read, again over
   * anyone else's save. The owner signs; the relay may refuse them. */
  async function change(
    session: RelaySession,
    reads: TaskSource,
    id: string,
    edit: (task: Task) => TaskFields,
    signal: AbortSignal,
    home?: string,
    revision?: string,
  ) {
    let task = await current(reads, id, signal);
    const from = task.home;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      signal.throwIfAborted();
      if (revision && task.revision !== revision)
        throw new Error(
          "The task changed since the move was previewed. Preview it again.",
        );
      const target =
        home && home !== task.home
          ? { op: "move" as const, base: task, home }
          : { op: "update" as const, base: task };
      const result = await save(session, reads, edit(task), target, signal);
      if (result.status === "saved") return result.task;
      // Someone else saved first; the agent's own read found their version.
      // A task that moved meanwhile isn't changed in its new place unseen.
      task = result.current;
      if (task.home !== from)
        throw new Error(
          "Someone moved this task while you were changing it. Nothing changed; read it again with tasks_find.",
        );
    }
    throw new Error("Others keep changing this task. Try again.");
  }

  agents.addTool({
    name: "tasks_find",
    description:
      'Finds tasks you can see, newest activity first. Use it to answer "what should I work on?": first assignee "me" (the person you work for), then open tasks nobody has taken. Searching a project covers everything filed in it. With id, reads one task in full.',
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Read this one task" },
        words: {
          type: "string",
          description: "Words in the title or description",
        },
        place: {
          type: "string",
          description:
            "A project, channel or chat id: its tasks, and for a project everything filed in it",
        },
        status: {
          type: "string",
          enum: ["open", "closed", "all"],
          description:
            "Open (To do, In progress; the default), closed (Done, Cancelled), or all",
        },
        assignee: {
          type: "string",
          description: '"me", "nobody", or a person\'s hex pubkey',
        },
      },
      additionalProperties: false,
    },
    async call(client, _context, args) {
      const session = sessionOf(client);
      const reads = agentReads(client, session);
      const signal = deadline(client);
      const id = textArg(args, "id");
      if (id) {
        const task = await current(reads, id, signal);
        return describe(
          task,
          session,
          await readPlaces(reads, [task.home], signal),
        );
      }
      const words = (textArg(args, "words") ?? "").trim();
      const place = channelArg(args, "place");
      const assignee = textArg(args, "assignee");
      if (
        assignee &&
        assignee !== "me" &&
        assignee !== "nobody" &&
        !isPubkey(assignee)
      )
        throw new Error('assignee must be "me", "nobody" or a hex pubkey');
      const { tasks: found, complete } = await readTasks(reads, signal, {
        status:
          args.status === "all"
            ? undefined
            : args.status === "closed"
              ? CLOSED
              : OPEN,
        assignee:
          assignee === "me"
            ? session.viewer
            : assignee === "nobody"
              ? null
              : assignee,
        within: place,
      });
      const tasks = found
        .filter(
          (task) =>
            !words || holdsWords(words, `${task.title} ${task.description}`),
        )
        .sort(byRecent);
      const more = complete ? "" : INCOMPLETE;
      if (!tasks.length) return `No tasks match.${more}`;
      return (
        tasks
          .slice(0, LIST_LIMIT)
          .map((task) => summary(task, session))
          .concat(
            tasks.length > LIST_LIMIT
              ? [`…and ${tasks.length - LIST_LIMIT} more`]
              : [],
          )
          .join("\n") + more
      );
    },
  });

  agents.addTool({
    name: "tasks_create",
    description:
      "Creates a task from what you're working on, without asking first: a short title, a Markdown description that makes sense to someone who can't read this conversation, and image links. It lives in place (default: this conversation), and everyone who can open that place can see it. It first looks for an open task about the same thing there, across its whole project: a clear match is returned instead, so comment on it with tasks_comment; a possible match is returned for the person to decide, and only then create with new_anyway. If you can't see place or the person you work for can't post there, nothing is created: say so, never put it somewhere else. Reply with the task's id, where it lives and who can see it.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title" },
        description: {
          type: "string",
          description: "Markdown: the context someone needs to pick this up",
        },
        images: {
          type: "array",
          items: { type: "string" },
          description: "https media links of images, as messages attach them",
        },
        place: {
          type: "string",
          description:
            "Project, channel or chat id to put it in (default: this conversation)",
        },
        link: {
          type: "boolean",
          description:
            "Link this conversation to it (default true). Only people who can read this conversation see the link.",
        },
        new_anyway: {
          type: "boolean",
          description:
            "Create even though a possible match exists, once the person said so",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    async call(client, context, args) {
      const session = sessionOf(client);
      const reads = agentReads(client, session);
      const signal = deadline(client);
      const home = channelArg(args, "place") ?? context.channel;
      if (!isChannelId(home))
        throw new Error("Say which project, channel or chat it goes in");
      const fields = checkedFields({
        title: textArg(args, "title") ?? "",
        description: textArg(args, "description") ?? "",
        status: "todo",
        images: imagesArg(args) ?? [],
        assignees: [],
      });
      const places = await readable(reads, home, signal);
      // The whole project the place is in, or the place itself.
      const project = places.get(home)?.parent ?? home;
      const { tasks: open, complete } = await readTasks(reads, signal, {
        status: OPEN,
        within: project,
      });
      const scored = open
        .map((task) => ({ task, score: sameness(fields.title, task.title) }))
        .sort((a, b) => b.score - a.score);
      const best = scored[0];
      if (best && best.score >= CLEAR_MATCH)
        return `Not created: open task ${best.task.id} is about the same thing. Comment on it with tasks_comment instead.\n\n${summary(best.task, session)}`;
      const possible = scored.filter((item) => item.score >= POSSIBLE_MATCH);
      const unsure = complete ? "" : INCOMPLETE;
      if (possible.length && args.new_anyway !== true)
        return `Not created yet: these open tasks may be about the same thing. Ask the person whether one of them is it; if not, call tasks_create again with new_anyway.\n\n${possible
          .slice(0, 5)
          .map((item) => summary(item.task, session))
          .join("\n")}${unsure}`;
      // Named before saving, so a retry after an unclear outcome can check.
      const id = crypto.randomUUID();
      const result = await save(
        session,
        reads,
        fields,
        { op: "create", home, id, via: client.pubkey },
        signal,
      ).catch((reason: unknown) => {
        throw new Error(
          `${reason instanceof Error ? reason.message : "Couldn't create the task."} It may still have been saved as task ${id}: read it with tasks_find before creating it again.`,
        );
      });
      if (result.status !== "saved")
        throw new Error("Couldn't create the task");
      const chat = context.channel;
      const linked =
        args.link !== false && isChannelId(chat) && chat !== home
          ? await setLink(session, reads, id, chat, true, signal).then(
              () =>
                "\nLinked this conversation; only people who can read it see that.",
              () => "\nCouldn't link this conversation.",
            )
          : "";
      const checked = complete
        ? ""
        : "\n(The check for an existing task may have missed some.)";
      return `Created task ${id}.${linked}${checked}\n\n${describe(result.task, session, places)}`;
    },
  });

  agents.addTool({
    name: "tasks_update",
    description:
      "Changes a task: title, description, images, assignees or status. Omitted fields stay. Set In progress when work starts; that assigns the person you work for. Set Done or Cancelled only with evidence, such as a merged pull request or someone saying it's finished, and give it as evidence: it's commented first, and the task closes only once the comment is in. To move a task, give only id and place: you get a preview of what changes, show it to the person, and only once they agree call again with the same id and place and the preview's confirm. Otherwise comment on progress instead.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        description: { type: "string", description: "Markdown" },
        images: {
          type: "array",
          items: { type: "string" },
          description: "https media links; replaces the whole list",
        },
        assignees: {
          type: "array",
          items: { type: "string" },
          description:
            "People's hex pubkeys, up to four, who can see the task; replaces the list",
        },
        status: { type: "string", enum: [...statuses] },
        evidence: {
          type: "string",
          description: "Required for done or cancelled: one line saying why",
        },
        place: {
          type: "string",
          description:
            "Move it to this project, channel or chat id, on its own: first a preview, then with confirm",
        },
        confirm: {
          type: "string",
          description:
            "The confirm from a move preview, once the person agreed to it",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async call(client, _context, args) {
      const session = sessionOf(client);
      const reads = agentReads(client, session);
      const id = textArg(args, "id") ?? "";
      const place = channelArg(args, "place");
      const signal = deadline(client);
      if (place) return move(session, reads, id, place, args, signal);
      if (args.confirm !== undefined)
        throw new Error("confirm goes with the place of a move preview");
      const title = textArg(args, "title");
      const description = textArg(args, "description");
      const images = imagesArg(args);
      const assignees = assigneesArg(args);
      const status =
        args.status === undefined ? undefined : statusOf(args.status);
      if (args.status !== undefined && !status)
        throw new Error(`status must be one of ${statuses.join(", ")}`);
      const evidence = textArg(args, "evidence")?.trim();
      const closing = status === "done" || status === "cancelled";
      if (closing && !evidence)
        throw new Error(
          "Done or Cancelled needs evidence: say in one line why, such as the merged pull request or who said it's finished",
        );
      const task = await current(reads, id, signal);
      // Only the people it adds: someone assigned who has since lost access
      // doesn't block an edit, as the relay rules too.
      if (assignees)
        await checkAssignees(
          session,
          reads,
          task.home,
          assignees.filter((key) => !task.assignees.includes(key)),
          signal,
        );
      // The evidence comes first: no comment, no close.
      if (closing && evidence && task.status !== status)
        await postAgentComment(
          client,
          task,
          `${statusLabels[status]}: ${evidence}`,
        );
      const viewer = session.viewer;
      const saved = await change(
        session,
        reads,
        id,
        (base) => {
          const people = assignees ?? base.assignees;
          // Starting work assigns the person the agent works for.
          const starting =
            status === "in_progress" &&
            base.status !== "in_progress" &&
            !!viewer &&
            !people.includes(viewer) &&
            people.length < MAX_ASSIGNEES;
          return {
            ...base,
            ...(title !== undefined && { title }),
            ...(description !== undefined && { description }),
            ...(images && { images }),
            ...(status && { status }),
            assignees: starting && viewer ? [...people, viewer] : people,
          };
        },
        signal,
      ).catch((reason: unknown) => {
        if (!closing) throw reason;
        throw new Error(
          `The evidence comment is in, but the task didn't close: ${
            reason instanceof Error ? reason.message : "the save failed"
          }`,
        );
      });
      const places = await readPlaces(reads, [saved.home], signal);
      return `Updated.\n\n${describe(saved, session, places)}`;
    },
  });

  /** A move: first what it changes, by place, and who it unassigns; then,
   * with that preview's confirm, the move itself. */
  async function move(
    session: RelaySession,
    reads: TaskSource,
    id: string,
    to: string,
    args: Args,
    signal: AbortSignal,
  ) {
    const others = Object.keys(args).filter(
      (key) => !["id", "place", "confirm"].includes(key),
    );
    if (others.length)
      throw new Error(
        `Move a task on its own: change ${others.join(", ")} in another call`,
      );
    const task = await current(reads, id, signal);
    if (task.home === to) return "It already lives there. Nothing changed.";
    await readable(reads, to, signal);
    const places = await readPlaces(reads, [task.home, to], signal);
    const confirm = textArg(args, "confirm");
    if (confirm) {
      const preview = previews.get(confirm);
      previews.delete(confirm);
      if (
        !preview ||
        preview.expires < Date.now() ||
        preview.task !== task.id ||
        preview.to !== to
      )
        throw new Error(
          "That confirm isn't from a preview of this move. Preview it again.",
        );
      const moved = await change(
        session,
        reads,
        id,
        (base) => ({ ...base, assignees: preview.keep }),
        signal,
        to,
        preview.revision,
      );
      return `Moved.\n\n${describe(moved, session, places)}`;
    }
    const { gain, lose } = accessChange(task.home, to, places);
    const readers = await readReaders(reads, to, signal);
    const keep = readers.anyone
      ? task.assignees
      : task.assignees.filter((pubkey) => readers.people.has(pubkey));
    const dropped = task.assignees.filter((pubkey) => !keep.includes(pubkey));
    for (const [key, value] of previews)
      if (value.expires < Date.now()) previews.delete(key);
    const token = crypto.randomUUID();
    previews.set(token, {
      task: task.id,
      revision: task.revision,
      to,
      keep,
      expires: Date.now() + PREVIEW_TTL,
    });
    const named = (list: readonly Place[]) =>
      list.map((place) => placeLabel(place, places)).join(", ");
    const destination = labelOf(to, places);
    return [
      `Not moved yet. Moving "${task.title}" to ${destination}:`,
      ...(gain.length
        ? [
            `- Everyone in ${named(gain)} will be able to see it and its comments.`,
          ]
        : []),
      ...(lose.length
        ? [`- People who are only in ${named(lose)} will lose access.`]
        : []),
      ...dropped.map(
        (pubkey) =>
          `- ${nameOf(session, pubkey)} can't see ${destination} and will be unassigned.`,
      ),
      "",
      `Show this to the person. Only if they agree, call tasks_update with id, place and confirm "${token}".`,
    ].join("\n");
  }

  agents.addTool({
    name: "tasks_comment",
    description:
      "Comments on a task as you, such as progress, a summary of a thread about it, or the answer to a question in it. Everyone who can see the task reads it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The task's id" },
        text: { type: "string", description: "Markdown" },
      },
      required: ["id", "text"],
      additionalProperties: false,
    },
    async call(client, _context, args) {
      const session = sessionOf(client);
      const signal = deadline(client);
      const text = (textArg(args, "text") ?? "").trim();
      if (!text) throw new Error("text must not be empty");
      const task = await current(
        agentReads(client, session),
        textArg(args, "id") ?? "",
        signal,
      );
      await postAgentComment(client, task, text);
      return `Commented on ${task.id}.`;
    },
  });
}

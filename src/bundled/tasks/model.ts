// A task is one NIP-AR artifact (kind 45010) of type `buzz.task`. Its `h` is
// its home, a project, channel or chat, and the relay lets read it whoever
// can read that home and edit it whoever can post there. Each revision is
// the complete snapshot: what the relay filters on and checks in tags
// (`status`, one `assignee` per person, `creator`), the rest in content. The
// relay keeps the revision history and refuses an edit whose `prev` is stale.
import { ARTIFACT_KIND } from "../../features/agents/agent-config-artifacts";
import type { EventData } from "../../features/relay/events";

export const TASK_TYPE = "buzz.task";
const CONTENT_VERSION = 3;

export const statuses = ["todo", "in_progress", "done", "cancelled"] as const;
export type TaskStatus = (typeof statuses)[number];
export const statusLabels: Readonly<Record<TaskStatus, string>> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Cancelled",
};
/** To do and In progress; Done and Cancelled are closed. */
export const isOpenStatus = (status: TaskStatus) =>
  status === "todo" || status === "in_progress";

export type TaskImage = Readonly<{
  url: string;
  type?: string | undefined;
  dim?: string | undefined;
}>;

/** What people edit. Assignees are people's pubkeys. */
export type TaskFields = Readonly<{
  title: string;
  description: string;
  status: TaskStatus;
  images: readonly TaskImage[];
  assignees: readonly string[];
}>;

export type Task = TaskFields &
  Readonly<{
    /** The artifact's `d`: stable across edits and moves. */
    id: string;
    /** The artifact's `h`: the project, channel or chat it lives in. */
    home: string;
    /** Who signed its first revision, as its `creator` tag carries forward
     * (the relay checks it); undefined when a revision lacks one. */
    creator: string | undefined;
    /** The agent that made it for its creator, as that agent's tool noted.
     * A label only: the creator answers for it. */
    via: string | undefined;
    /** The current revision: its id is the next edit's `prev`. */
    revision: string;
    /** Who signed the current revision, and when. */
    editor: string;
    updatedAt: number;
  }>;

export const MAX_ASSIGNEES = 4;
const MAX_TITLE = 200;
const MAX_IMAGES = 32;
const HEX64 = /^[0-9a-f]{64}$/;
const CHANNEL =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const tag = (event: EventData, name: string) =>
  event.tags.find((entry) => entry[0] === name)?.[1];

const tags = (event: EventData, name: string) =>
  event.tags.flatMap((entry) => (entry[0] === name ? [entry[1]] : []));

const text = (value: unknown) => (typeof value === "string" ? value : "");

export const isChannelId = (value: unknown): value is string =>
  typeof value === "string" && CHANNEL.test(value);

export const isPubkey = (value: unknown): value is string =>
  typeof value === "string" && HEX64.test(value);

/** Only HTTPS links render; anything else in an untrusted record is dropped. */
export function imageOf(value: unknown): TaskImage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { url, type, dim } = value as Record<string, unknown>;
  if (typeof url !== "string") return undefined;
  try {
    if (new URL(url).protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return {
    url,
    ...(typeof type === "string" && type.startsWith("image/") ? { type } : {}),
    ...(typeof dim === "string" && /^\d{1,5}x\d{1,5}$/.test(dim)
      ? { dim }
      : {}),
  };
}

/** A current revision as a task, or undefined when it is not a readable one. */
export function taskOf(event: EventData & { id: string }): Task | undefined {
  if (event.kind !== ARTIFACT_KIND || tag(event, "type") !== TASK_TYPE)
    return undefined;
  const id = tag(event, "d");
  const home = tag(event, "h");
  if (!isChannelId(id) || !isChannelId(home)) return undefined;
  let content: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    content = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const creator = tag(event, "creator");
  const via = tag(event, "via");
  return {
    id,
    home,
    title: (tag(event, "title") ?? "").slice(0, MAX_TITLE),
    description: text(content.description),
    status: statuses.find((item) => item === tag(event, "status")) ?? "todo",
    images: (Array.isArray(content.images) ? content.images : [])
      .flatMap((item) => imageOf(item) ?? [])
      .slice(0, MAX_IMAGES),
    assignees: [...new Set(tags(event, "assignee").filter(isPubkey))].slice(
      0,
      MAX_ASSIGNEES,
    ),
    creator: isPubkey(creator) ? creator : undefined,
    via: isPubkey(via) ? via : undefined,
    revision: event.id,
    editor: event.pubkey,
    updatedAt: event.created_at,
  };
}

/** Fields checked and trimmed for saving; throws with a person-readable reason. */
export function checkedFields(fields: TaskFields): TaskFields {
  const title = fields.title.trim().replace(/\s+/g, " ");
  if (!title) throw new Error("Give the task a title.");
  if (title.length > MAX_TITLE)
    throw new Error(`Keep the title under ${MAX_TITLE} characters.`);
  if (fields.images.length > MAX_IMAGES)
    throw new Error(`A task holds up to ${MAX_IMAGES} images.`);
  const assignees = [...new Set(fields.assignees)];
  if (!assignees.every(isPubkey)) throw new Error("Assign people only.");
  if (assignees.length > MAX_ASSIGNEES)
    throw new Error(`A task has up to ${MAX_ASSIGNEES} assignees.`);
  return {
    title,
    description: fields.description,
    status: fields.status,
    images: fields.images,
    assignees,
  };
}

/** The revision's content: what no relay rule reads. */
export const taskContent = (fields: TaskFields) =>
  JSON.stringify({
    version: CONTENT_VERSION,
    description: fields.description,
    images: fields.images,
  });

/** The revision's tags the relay filters on and checks. */
export const taskTags = (fields: TaskFields) => [
  ["status", fields.status],
  ...fields.assignees.map((pubkey) => ["assignee", pubkey]),
];

/** Newest activity first, then by id, so equal times keep one order. */
export const byRecent = (a: Task, b: Task) =>
  b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);

/** Assigned to the viewer, or created by them. What their agent creates is
 * theirs too: the agent's tools sign as its owner. */
export const isMine = (task: Task, viewer: string) =>
  task.creator === viewer || task.assignees.includes(viewer);

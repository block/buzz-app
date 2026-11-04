import type { ChannelMessage } from "../../features/relay/contracts";
import { messagePreview } from "../../features/notifications/content";
import { replaceView, viewRevision } from "../../shared/view-state";

export const key = "decision-inbox:v1";
export type Stage = "decision" | "handoff" | "done";
export type Decision = Readonly<{
  channelId: string;
  messageId: string;
  threadRootId?: string;
  preview: string;
  question: string;
  nextActor: string;
  decision: string;
  stage: Stage;
  createdAt: number;
}>;
export type List =
  | Readonly<{ status: "ready"; records: readonly Decision[] }>
  | Readonly<{ status: "damaged" }>
  | Readonly<{ status: "unavailable" }>;

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max;
const messageId = (value: unknown) =>
  typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);

function valid(value: unknown): value is Decision {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    text(item.channelId, 256) &&
    (item.channelId as string).length > 0 &&
    messageId(item.messageId) &&
    (item.threadRootId === undefined || messageId(item.threadRootId)) &&
    text(item.preview, 400) &&
    text(item.question, 1000) &&
    (item.question as string).trim().length > 0 &&
    text(item.nextActor, 200) &&
    (item.nextActor as string).trim().length > 0 &&
    text(item.decision, 2000) &&
    (item.stage === "decision" ||
      item.stage === "handoff" ||
      item.stage === "done") &&
    (item.stage === "decision" ||
      (item.decision as string).trim().length > 0) &&
    Number.isSafeInteger(item.createdAt) &&
    (item.createdAt as number) >= 0
  );
}

export function readList(revision: string | null | undefined): List {
  if (revision === undefined) return { status: "unavailable" };
  if (revision === null) return { status: "ready", records: [] };
  try {
    const data: unknown = JSON.parse(revision);
    if (
      !Array.isArray(data) ||
      data.length > 500 ||
      !data.every(valid) ||
      new Set(data.map((item: Decision) => sourceKey(item))).size !==
        data.length
    )
      return { status: "damaged" };
    return { status: "ready", records: data };
  } catch {
    return { status: "damaged" };
  }
}

export const sourceKey = (item: Pick<Decision, "channelId" | "messageId">) =>
  JSON.stringify([item.channelId, item.messageId]);

type WriteResult =
  | "saved"
  | "changed"
  | "failed"
  | "scope-changed"
  | "unavailable";

async function writeWithLock<T extends string>(
  scope: string,
  current: () => boolean,
  write: () => T,
): Promise<T | "scope-changed" | "unavailable" | "failed"> {
  if (!current()) return "scope-changed";
  const locks = navigator.locks;
  if (!locks?.request) return "unavailable";
  try {
    return await locks.request(
      `buzz-decision-inbox:${scope}`,
      { mode: "exclusive" },
      () => (current() ? write() : "scope-changed"),
    );
  } catch {
    return "failed";
  }
}

export function save(
  scope: string,
  expected: string | null | undefined,
  record: Decision,
  current: () => boolean,
): Promise<WriteResult | "damaged" | "full"> {
  return writeWithLock(scope, current, () => {
    const list = readList(expected);
    if (list.status !== "ready")
      return list.status === "damaged" ? "damaged" : "failed";
    const records = list.records.filter(
      (item) => sourceKey(item) !== sourceKey(record),
    );
    if (!valid(record)) return "failed";
    const latest = viewRevision(scope, key);
    if (latest === undefined) return "failed";
    if (latest !== expected) return "changed";
    if (records.length >= 500) return "full";
    return replaceView(scope, key, expected, [record, ...records]);
  });
}

export function remove(
  scope: string,
  expected: string | null | undefined,
  record: Pick<Decision, "channelId" | "messageId">,
  current: () => boolean,
): Promise<WriteResult | "damaged"> {
  return writeWithLock(scope, current, () => {
    const list = readList(expected);
    if (list.status !== "ready")
      return list.status === "damaged" ? "damaged" : "failed";
    const records = list.records.filter(
      (item) => sourceKey(item) !== sourceKey(record),
    );
    if (records.length === list.records.length) return "changed";
    return replaceView(scope, key, expected, records);
  });
}

export function reset(
  scope: string,
  expected: string,
  current: () => boolean,
): Promise<WriteResult> {
  return writeWithLock(scope, current, () => {
    if (readList(expected).status !== "damaged") return "changed";
    return replaceView(scope, key, expected, []);
  });
}

export function capture(
  message: ChannelMessage,
  question: string,
  nextActor: string,
): Decision {
  return {
    channelId: message.channelId,
    messageId: message.id,
    ...(message.threadRootId ? { threadRootId: message.threadRootId } : {}),
    preview: messagePreview(message.content),
    question: question.trim(),
    nextActor: nextActor.trim(),
    decision: "",
    stage: "decision",
    createdAt: Date.now(),
  };
}

export const revision = (scope: string) => viewRevision(scope, key);

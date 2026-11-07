import { movedSource } from "./provenance";
import type { EventData } from "../relay/events";
import { eventMs } from "../relay/message-order";
import type { ChannelSummary } from "../relay/contracts";

export const MOVE_TOPIC = "buzz:dm-move:v1";
export const MOVE_TAG = "buzz:dm-move";
const hex = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const channel = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/;
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const key = (value: unknown): value is string =>
  typeof value === "string" && hex.test(value);
const keys = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 9 &&
  value.every(key) &&
  new Set(value).size === value.length;
export type MoveRequest = Readonly<{
  type: "request";
  move: string;
  target: string;
  worker: string;
  expires: number;
  /** Each source author and the human whose approval covers them. */
  authors: readonly (readonly [string, string])[];
  /** Inclusive original-message order boundary. */
  from?: Readonly<{ id: string; ms: number }>;
}>;
export type MoveControl =
  | MoveRequest
  | Readonly<{
      move: string;
      type:
        | "approve"
        | "decline"
        | "cancel"
        | "ready"
        | "probe"
        | "commit"
        | "go"
        | "done";
      request?: string;
      reason?: string | undefined;
      worker?: string;
      nonce?: string;
      root?: string | undefined;
      through?: number | undefined;
    }>;
export type ControlEvent = {
  event: EventData;
  control: MoveControl;
  dm: string;
};

/** The only control envelope the feature recognizes; malformed chat remains ordinary chat. */
export function moveControl(event: EventData): ControlEvent | undefined {
  if (
    event.kind !== 9 ||
    event.content.length > 8192 ||
    !event.tags.some(
      (t) => t.length === 2 && t[0] === "t" && t[1] === MOVE_TOPIC,
    )
  )
    return;
  const destinations = event.tags.filter((t) => t[0] === "h");
  const dm = destinations[0]?.[1];
  if (
    destinations.length !== 1 ||
    destinations[0]?.length !== 2 ||
    !dm ||
    !channel.test(dm) ||
    event.tags.some((t) => t[0] === "e")
  )
    return;
  let value: unknown;
  try {
    value = JSON.parse(event.content);
  } catch {
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (typeof v.move !== "string" || !uuid.test(v.move)) return;
  const allowed =
    v.type === "request"
      ? ["type", "move", "target", "worker", "expires", "authors", "from"]
      : [
          "type",
          "move",
          "request",
          ...(["approve", "ready", "done"].includes(String(v.type))
            ? ["worker"]
            : []),
          ...(v.type === "decline" ? ["reason"] : []),
          ...(["probe", "ready"].includes(String(v.type)) ? ["nonce"] : []),
          ...(v.type === "go" ? ["root", "nonce"] : []),
          ...(v.type === "commit" ? ["nonce", "through"] : []),
        ];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return;
  if (v.type === "request") {
    if (typeof v.worker !== "string" || !uuid.test(v.worker)) return;
    if (
      typeof v.target !== "string" ||
      !channel.test(v.target) ||
      v.target === dm ||
      !integer(v.expires) ||
      v.expires <= event.created_at ||
      v.expires > event.created_at + 30 * 86400
    )
      return;
    if (
      !Array.isArray(v.authors) ||
      !v.authors.length ||
      v.authors.length > 9 ||
      !v.authors.every(
        (pair) => Array.isArray(pair) && pair.length === 2 && pair.every(key),
      )
    )
      return;
    const pairs = v.authors as [string, string][];
    if (
      new Set(pairs.map((p) => p[0])).size !== pairs.length ||
      !pairs.some((p) => p[0] === event.pubkey && p[1] === event.pubkey) ||
      pairs.some((p) => !pairs.some((a) => a[0] === p[1] && a[1] === p[1]))
    )
      return;
    if (v.from !== undefined) {
      if (!v.from || typeof v.from !== "object" || Array.isArray(v.from))
        return;
      const f = v.from as Record<string, unknown>;
      if (Object.keys(f).length !== 2 || !key(f.id) || !integer(f.ms)) return;
    }
  } else if (
    ![
      "approve",
      "decline",
      "cancel",
      "probe",
      "ready",
      "commit",
      "go",
      "done",
    ].includes(String(v.type))
  )
    return;
  if (v.type !== "request" && !key(v.request)) return;
  if (
    ["approve", "ready", "done"].includes(String(v.type)) &&
    (typeof v.worker !== "string" || !uuid.test(v.worker))
  )
    return;
  if (
    ["probe", "ready", "commit", "go"].includes(String(v.type)) &&
    (typeof v.nonce !== "string" || !uuid.test(v.nonce))
  )
    return;
  if (v.type === "commit" && !integer(v.through)) return;
  if (v.type === "go" && !key(v.root)) return;
  if (
    v.reason !== undefined &&
    (typeof v.reason !== "string" || [...v.reason].length > 240)
  )
    return;
  return { event, control: v as MoveControl, dm };
}

export function controlTemplate(dm: string, control: MoveControl) {
  return {
    kind: 9,
    tags: [
      ["h", dm],
      ["t", MOVE_TOPIC],
      ["d", control.move],
    ],
    content: JSON.stringify(control),
  };
}
export type MoveState = Readonly<{
  request: ControlEvent & { control: MoveRequest };
  approvers: readonly string[];
  approved: readonly string[];
  waiting: readonly string[];
  status:
    | "pending"
    | "approved"
    | "committing"
    | "posting"
    | "complete"
    | "declined"
    | "cancelled"
    | "expired";
  actor?: string;
  reason?: string | undefined;
  probe?: ControlEvent | undefined;
  ready: readonly string[];
  workers: ReadonlyMap<string, string>;
  root?: string | undefined;
  through?: number | undefined;
}>;

/** All decisions come from verified DM events. A sender never votes for another human. */
export function moveState(
  request: ControlEvent & { control: MoveRequest },
  records: readonly ControlEvent[],
  now: number,
): MoveState {
  const req = request.control;
  const approvers = [...new Set(req.authors.map((pair) => pair[1]))];
  const relevant = records.filter(
    (r) =>
      r.dm === request.dm &&
      r.control.move === req.move &&
      r.control.type !== "request" &&
      r.control.request === request.event.id &&
      r.event.created_at >= request.event.created_at &&
      approvers.includes(r.event.pubkey),
  );
  const approvals = relevant
    .filter(
      (r) => r.control.type === "approve" && r.event.created_at < req.expires,
    )
    .sort(
      (a, b) =>
        eventMs(a.event) - eventMs(b.event) ||
        a.event.id.localeCompare(b.event.id),
    );
  const workers = new Map<string, string>();
  for (const a of approvals)
    if (
      !workers.has(a.event.pubkey) &&
      a.control.type === "approve" &&
      a.control.worker
    )
      workers.set(a.event.pubkey, a.control.worker);
  const approved = approvers.filter((p) =>
    approvals.some((r) => r.event.pubkey === p),
  );
  const waiting = approvers.filter((p) => !approved.includes(p));
  const base = {
    request,
    approvers,
    approved,
    waiting,
    workers,
    ready: [] as string[],
  };
  const finalApprovalMs = waiting.length
    ? Infinity
    : Math.max(
        ...approvers.map((p) =>
          Math.min(
            ...approvals
              .filter((r) => r.event.pubkey === p)
              .map((r) => eventMs(r.event)),
          ),
        ),
      );
  const decline = relevant.find(
    (r) =>
      r.control.type === "decline" &&
      r.event.created_at < req.expires &&
      eventMs(r.event) < finalApprovalMs,
  );
  if (decline)
    return {
      ...base,
      status: "declined",
      actor: decline.event.pubkey,
      reason:
        decline.control.type !== "request" ? decline.control.reason : undefined,
    };
  const initiated = relevant.filter(
    (r) => r.event.pubkey === request.event.pubkey,
  );
  const commit = initiated.find((r) => r.control.type === "commit");
  const beforeCommit = (r: ControlEvent) =>
    !commit || eventMs(r.event) <= eventMs(commit.event);
  const cancel = initiated.find(
    (r) => r.control.type === "cancel" && beforeCommit(r),
  );
  if (cancel)
    return { ...base, status: "cancelled", actor: cancel.event.pubkey };
  if (waiting.length)
    return { ...base, status: now >= req.expires ? "expired" : "pending" };
  const probe = initiated
    .filter((r) => r.control.type === "probe")
    .sort(
      (a, b) =>
        eventMs(b.event) - eventMs(a.event) ||
        b.event.id.localeCompare(a.event.id),
    )[0];
  const nonce =
    probe?.control.type !== "request" ? probe?.control.nonce : undefined;
  const ready = nonce
    ? approvers.filter((p) =>
        relevant.some(
          (r) =>
            r.control.type === "ready" &&
            r.control.worker === workers.get(p) &&
            r.control.nonce === nonce &&
            r.event.pubkey === p &&
            r.event.created_at >= (probe?.event.created_at ?? Infinity) &&
            r.event.created_at <= (probe?.event.created_at ?? 0) + 15,
        ),
      )
    : [];
  const go = initiated.find(
    (r) =>
      r.control.type === "go" &&
      r.control.nonce === nonce &&
      ready.length === approvers.length,
  );
  if (go?.control.type !== "go")
    return {
      ...base,
      status:
        commit && ready.length === approvers.length ? "committing" : "approved",
      probe,
      ready,
      through:
        commit?.control.type === "commit" ? commit.control.through : undefined,
    };
  const root = go.control.root;
  const complete = approvers.every((p) =>
    relevant.some(
      (r) =>
        r.control.type === "done" &&
        r.control.worker === workers.get(p) &&
        r.event.pubkey === p,
    ),
  );
  return {
    ...base,
    status: complete ? "complete" : "posting",
    probe,
    ready,
    root,
    through:
      commit?.control.type === "commit" ? commit.control.through : undefined,
  };
}

/** Reject unknown/private destinations and recheck the complete signed roster before publishing. */
export function validateMoveChannels(
  dm: ChannelSummary | undefined,
  target: ChannelSummary | undefined,
  authors: readonly string[],
  requireWrite = true,
) {
  if (
    dm?.channelType !== "dm" ||
    dm.cached ||
    dm.archived ||
    dm.readOnly ||
    !dm.members ||
    !keys([...dm.members]) ||
    dm.members.length !== authors.length ||
    dm.members.some((p) => !authors.includes(p))
  )
    throw new Error("Refresh the DM’s participants before converting it.");
  if (
    target?.channelType !== "stream" ||
    target.cached ||
    target.archived ||
    ((requireWrite ||
      target.viewerRole === "guest" ||
      target.joinRole === "guest") &&
      target.readOnly) ||
    (target.visibility === "private" && !target.members) ||
    !target.visibility
  )
    throw new Error("Choose a joined, writable text channel.");
  if (
    target.visibility === "private" &&
    authors.some((p) => !target.members?.includes(p))
  )
    throw new Error(
      "Everyone in the DM must already belong to this private channel.",
    );
}

/** The bounded kind-9 operations this feature may recover after relay expiry. */
export function moveOperation(event: EventData) {
  if (event.kind !== 9) return false;
  if (moveControl(event) || movedSource(event)) return true;
  const roots = event.tags.filter((t) => t[0] === "buzz:dm-move-root");
  return (
    roots.length === 1 &&
    roots[0]?.length === 2 &&
    uuid.test(roots[0]?.[1] ?? "") &&
    event.tags.filter((t) => t[0] === "h" && t.length === 2).length === 1 &&
    !event.tags.some((t) => t[0] === "e")
  );
}
export { movedSource };

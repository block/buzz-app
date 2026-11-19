import type { JsonValue } from "../navigation/targets";
import { HEX, UUID } from "./protocol";
import type { WorkflowReference } from "./types";

type WorkflowRoute = Pick<WorkflowReference, "owner" | "id">;

/** The Workflows page route that opens one workflow, as `{ owner, id }`. A
 * route is an address, never access: the page shows only what it can read. */
export function workflowRoute(
  params: JsonValue | undefined,
): WorkflowRoute | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  const { owner, id } = params as Readonly<Record<string, JsonValue>>;
  return Object.keys(params).length === 2 &&
    typeof owner === "string" &&
    HEX.test(owner) &&
    typeof id === "string" &&
    UUID.test(id)
    ? { owner, id }
    : undefined;
}

/** That route as a Buzz plugin page link, bound to the opener's community. */
export const workflowLink = ({ owner, id }: WorkflowRoute) =>
  `buzz://plugin?id=buzz.workflows&page=workflows&route.owner=${owner}&route.id=${id}`;

const pages = new Set<symbol>();
const watchers = new Set<() => void>();
/** Whether a page that opens `workflowLink` is running. Message UI offers the
 * link, and looks its workflow up, only while one is. */
export const workflowLinks = Object.freeze({
  available: () => pages.size > 0,
  subscribe(listener: () => void) {
    watchers.add(listener);
    return () => {
      watchers.delete(listener);
    };
  },
  /** Declares that page for as long as it is registered; returns its
   * withdrawal. */
  provide() {
    const page = Symbol();
    const change = (apply: () => unknown) => {
      apply();
      for (const listener of [...watchers]) listener();
    };
    change(() => pages.add(page));
    return () => change(() => pages.delete(page));
  },
});

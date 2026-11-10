import type { JsonValue, OpenTarget } from "../navigation/targets";
import { soloFork, type SoloFork } from "../relay/solo-fork-protocol";
import { splitPartition } from "../relay/partition";

/** An unsent Solo conversation: nothing exists on the relay until its first send. */
export type SoloDraft = Readonly<{
  project?: string;
  agent?: string;
  linked?: string;
}>;

const agentKey = /^[0-9a-f]{64}$/;

export function soloDraft(
  params: JsonValue | undefined,
): SoloDraft | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  const value = params as { readonly [key: string]: JsonValue };
  if (value.kind !== "solo-draft") return;
  if (
    Object.keys(value).some(
      (key) =>
        key !== "kind" &&
        key !== "project" &&
        key !== "agent" &&
        key !== "linked",
    )
  )
    return;
  const { project, agent, linked } = value;
  if (
    linked !== undefined &&
    (typeof linked !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        linked,
      ))
  )
    return;
  if (
    project !== undefined &&
    (typeof project !== "string" || !project || project.length > 256)
  )
    return;
  if (
    agent !== undefined &&
    (typeof agent !== "string" || !agentKey.test(agent))
  )
    return;
  return {
    ...(project ? { project } : {}),
    ...(agent ? { agent } : {}),
    ...(linked ? { linked } : {}),
  };
}

export function isChannelRoute(params: JsonValue) {
  return (
    params === "new-message" ||
    params === "empty" ||
    soloDraft(params) !== undefined ||
    soloForkDraft(params) !== undefined
  );
}

/** A new Solo conversation, optionally filed in a project or starting with an agent. */
export function soloDraftTarget(
  scope: string,
  draft: SoloDraft = {},
): OpenTarget {
  const parts = splitPartition(scope);
  const params = { kind: "solo-draft", ...draft };
  if (!parts || !soloDraft(params)) throw new Error("Invalid Solo destination");
  return {
    version: 1,
    kind: "page",
    pluginId: "buzz.channels",
    pageId: "channels",
    scope: parts,
    route: { version: 1, params },
  };
}

export function conversationTarget(
  scope: string,
  channelId: string,
): OpenTarget {
  const parts = splitPartition(scope);
  if (!parts) throw new Error("Invalid conversation destination");
  return { version: 1, kind: "conversation", scope: parts, channelId };
}

/** Presentation intent only; neither the address nor saved form admits ancestry. */
export type SoloForkDraft = SoloFork & { destination: string };
export function soloForkDraft(
  params: JsonValue | undefined,
): SoloForkDraft | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  if (
    Object.keys(params).some(
      (key) => !["kind", "channelId", "messageId", "destination"].includes(key),
    )
  )
    return;
  const value = params as { readonly [key: string]: JsonValue };
  if (value.kind !== "solo-fork") return;
  const { channelId, messageId, destination } = value;
  if (
    typeof channelId !== "string" ||
    typeof messageId !== "string" ||
    typeof destination !== "string"
  )
    return;
  try {
    soloFork({ tags: [["forked_from", channelId, messageId]] });
    soloFork({ tags: [["forked_from", destination, messageId]] });
    if (channelId !== destination) return { channelId, messageId, destination };
  } catch {
    /* Invalid addresses are not restorable forms. */
  }
}
export function soloForkTarget(
  scope: string,
  draft: SoloForkDraft,
): OpenTarget {
  const parts = splitPartition(scope);
  const params = { kind: "solo-fork", ...draft };
  if (!parts || !soloForkDraft(params))
    throw new Error("Invalid fork destination");
  return {
    version: 1,
    kind: "page",
    pluginId: "buzz.channels",
    pageId: "channels",
    scope: parts,
    route: { version: 1, params },
  };
}

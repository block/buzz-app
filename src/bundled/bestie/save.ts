import {
  type AttentionValue,
  interestSlug,
  watchSlug,
} from "../../features/agents/attention";
import type { Agent, Agents } from "../../features/agents/service";
import {
  dream,
  FEATURES,
  type Feature,
  featureState,
  hasFeature,
  LEGACY,
  memory,
  notes,
  restoredFeature,
  withFeature,
} from "./features";

/** What saving a feature needs. A caller of agents here only can leave out
 * `hostedInstructions`. */
export type FeatureAgents = Pick<Agents, "save" | "types"> &
  Partial<Pick<Agents, "hostedInstructions">>;

/** The agent's instructions, as its synced editor shows them. */
export function instructionsOf(agent: Agent) {
  const { instructions } = (agent.config ?? {}) as { instructions?: unknown };
  return typeof instructions === "string" ? instructions : "";
}

/** Why the agent's instructions can't take a feature here, if they can't.
 * `feature` is the one to add, which a hosted agent's provider may take if it
 * has no timer; without it, only an agent here can be edited. */
export function cannotEdit(
  agents: FeatureAgents,
  agent: Agent,
  feature?: Feature,
) {
  // A remote agent's instructions and timers aren't on this device: its
  // provider, or the device it runs on, holds them. A hosted agent's provider
  // may let its instructions be edited, but its timers never run here.
  if (agent.place !== "here")
    return agent.place === "hosted" &&
      feature &&
      !feature.timer &&
      agents.hostedInstructions?.(agent.pubkey)
      ? undefined
      : "Not available with remote agents yet.";
  // A type without `adopt` has no instructions, as `updateKind` says.
  if (!agents.types().find(({ key }) => key === agent.type)?.adopt)
    return "This agent's type has no instructions to add this to.";
  // Without a confirmed copy its instructions aren't shown, so a save here
  // would replace them.
  return agent.configProblem;
}

/** Whether `agent` has `feature` on: its section if it has one, and its
 * Interest and timer if it has a timer. Half of one, such as a timer deleted
 * in Watching, reads as off. */
export function featureOn(agent: Agent, feature: Feature) {
  return (
    (!feature.text || hasFeature(instructionsOf(agent), feature)) &&
    (!feature.timer ||
      (!!agent.attention[interestSlug(feature.timer.id)] &&
        !!agent.attention[watchSlug(feature.timer.id)]))
  );
}

/** Whether any of the feature's parts is there: its section, whole or
 * edited, or its Interest or timer. */
export function featurePresent(agent: Agent, feature: Feature) {
  return (
    featureState(instructionsOf(agent), feature) !== "off" ||
    (!!feature.timer &&
      (!!agent.attention[interestSlug(feature.timer.id)] ||
        !!agent.attention[watchSlug(feature.timer.id)]))
  );
}

/** The latest time at or before `now` that it is `hour` o'clock where this
 * device is, in unix seconds. */
function lastHour(hour: number, now: Date) {
  const at = new Date(now);
  at.setHours(hour, 0, 0, 0);
  if (at > now) at.setDate(at.getDate() - 1);
  return Math.floor(at.getTime() / 1000);
}

/** Turns `feature` on or off as its switch does, revising the synced
 * instructions as their editor would. Off also turns off the features that
 * require it. A timer is delivered to `channel`, the owner's DM with the
 * agent. With `timerOnly`, the instructions, which each of the agent's
 * communities shares, are left as they are. Attention is saved first: if the
 * instructions then fail to save, On undoes its timer, and the half Off
 * leaves reads as off, which turning it either way finishes. On refuses a
 * section edited by hand: Restore puts it back first. Once `signal` aborts,
 * the instructions aren't saved. */
export async function saveFeature(
  agents: FeatureAgents,
  agent: Agent,
  feature: Feature,
  on: boolean,
  {
    channel,
    timerOnly = false,
    signal,
  }: { channel?: string; timerOnly?: boolean; signal?: AbortSignal } = {},
) {
  if (on && featureState(instructionsOf(agent), feature) === "edited")
    throw new Error(
      `${feature.title} was edited in Instructions; restore it first.`,
    );
  const off = on
    ? []
    : [feature, ...FEATURES.filter(({ requires }) => requires === feature.id)];
  const attention: Record<string, AttentionValue | null> = {};
  for (const { timer } of off)
    for (const slug of timer
      ? [interestSlug(timer.id), watchSlug(timer.id)]
      : [])
      if (agent.attention[slug]) attention[slug] = null;
  const timer = on && feature.timer;
  if (timer) {
    if (!channel) throw new Error("A check-in needs your DM with the agent.");
    attention[interestSlug(timer.id)] = {
      type: "interest",
      instructions: timer.interest,
    };
    attention[watchSlug(timer.id)] = {
      type: "timer",
      interest_id: timer.id,
      prompt: timer.prompt,
      enabled: true,
      interval_secs: timer.everySecs,
      // A timer is next due one interval after it is armed.
      armed_at:
        timer.atHour === undefined
          ? Math.floor(Date.now() / 1000)
          : lastHour(timer.atHour, new Date()),
      max_occurrences: null,
      expires_at: null,
      channel,
    };
  }
  if (Object.keys(attention).length)
    await agents.save(agent.key, { attention });
  if (timerOnly) return;
  const instructions = instructionsOf(agent);
  const next = on
    ? withFeature(instructions, feature, true)
    : off.reduce((text, item) => withFeature(text, item, false), instructions);
  if (next === instructions) return;
  // The caller may have stopped while Attention saved.
  signal?.throwIfAborted();
  try {
    await saveInstructions(agents, agent, next);
  } catch (cause) {
    // A failed On undoes what it saved, so no timer runs behind a switch
    // that reads off.
    if (timer)
      await agents
        .save(agent.key, {
          attention: Object.fromEntries(
            Object.keys(attention).map((slug) => [
              slug,
              agent.attention[slug]?.value ?? null,
            ]),
          ),
        })
        .catch(() => {
          throw new Error(
            `${cause instanceof Error ? cause.message : String(cause)} Its timer may still be saved; remove it below.`,
          );
        });
    throw cause;
  }
}

/** Replaces the hourly check-in of an earlier version, which keeps its steps
 * in the instructions, with Hourly notes and Nightly review. If it was on,
 * with memory, they are turned on in the DM its timer was delivered to,
 * before the old section, Interest and timer are taken away, so a failure
 * leaves it to be tried again. If it was not on, as when half of it was
 * deleted, it is only removed. With `timerOnly`, the instructions, which each
 * of the agent's communities shares, are left as they are. */
export async function replaceCheckIn(
  agents: FeatureAgents,
  agent: Agent,
  options: { timerOnly?: boolean; signal?: AbortSignal } = {},
) {
  const old = LEGACY.filter((feature) => featurePresent(agent, feature));
  if (!old.length) return;
  const [channel] = old.flatMap(({ timer }) => {
    const wake = timer && agent.attention[watchSlug(timer.id)]?.value;
    return wake?.type === "timer" && wake.channel ? [wake.channel] : [];
  });
  // On is its section, whole, and its timer, which says where it ran.
  if (
    channel &&
    featureOn(agent, memory) &&
    old.some((feature) => hasFeature(instructionsOf(agent), feature))
  )
    for (const feature of [notes, dream]) {
      options.signal?.throwIfAborted();
      await saveFeature(agents, agent, feature, true, {
        channel,
        ...(options.signal && { signal: options.signal }),
      });
    }
  for (const feature of old) {
    options.signal?.throwIfAborted();
    await saveFeature(agents, agent, feature, false, options);
  }
}

/** Puts back the feature's section edited by hand, as the editor would save
 * it. */
export async function restoreFeature(
  agents: FeatureAgents,
  agent: Agent,
  feature: Feature,
) {
  const next = restoredFeature(instructionsOf(agent), feature);
  if (next === undefined)
    throw new Error(`Fix ${feature.title}'s markers in Instructions.`);
  await saveInstructions(agents, agent, next);
}

/** Saves `instructions` as the next revision of the copy `agent` shows, or,
 * for a hosted agent, through its provider. */
function saveInstructions(
  agents: FeatureAgents,
  agent: Agent,
  instructions: string,
) {
  if (agent.place === "hosted") {
    const hosted = agents.hostedInstructions?.(agent.pubkey);
    if (!hosted) throw new Error("Not available with remote agents yet.");
    // Its provider replaces the copy this switch shows, never a newer one.
    return hosted.set(instructions, instructionsOf(agent));
  }
  return agents.save(agent.key, {
    config: { ...(agent.config as object), instructions },
    ...(agent.configBase && { base: agent.configBase }),
  });
}

import { useState } from "react";
import type { Config } from "./runtime";

const groups = {
  model: ["model", "effort"],
  instructions: ["instructions"],
  workspace: ["workspace"],
  scope: ["scope"],
} as const;
export type SettingGroup = keyof typeof groups;
export const settingLabels: Record<SettingGroup, string> = {
  model: "Model and thinking",
  instructions: "Instructions",
  workspace: "Workspace",
  scope: "Sessions",
};
const names = Object.keys(groups) as SettingGroup[];
const same = (a: Config, b: Config, group: SettingGroup) =>
  groups[group].every((key) => a[key] === b[key]);
const copy = (from: Config, group: SettingGroup) =>
  Object.fromEntries(groups[group].map((key) => [key, from[key]]));

type Draft = {
  key: string;
  saved: Config;
  value: Config;
  conflicts: SettingGroup[];
  submitted?: Config;
  awaiting?: SettingGroup[];
  pending?: boolean;
};

/** Reconcile values, not object identity: config readers normalize every render.
 * Model and effort travel together; independent settings can merge safely. */
function reconcile(prior: Draft, saved: Config): Draft {
  let value = saved;
  const conflicts: SettingGroup[] = [];
  const awaiting = [...(prior.awaiting ?? [])];
  for (const group of names) {
    // Publication may arrive before or after the save promise, including a
    // partial save. Acknowledging submitted values must preserve later edits.
    const acknowledged =
      prior.submitted &&
      awaiting.includes(group) &&
      same(saved, prior.submitted, group);
    const base =
      acknowledged && prior.submitted ? prior.submitted : prior.saved;
    if (acknowledged) awaiting.splice(awaiting.indexOf(group), 1);
    if (same(prior.value, base, group)) continue;
    value = { ...value, ...copy(prior.value, group) };
    if (
      !same(value, saved, group) &&
      (prior.conflicts.includes(group) || !same(saved, base, group))
    )
      conflicts.push(group);
  }
  return { ...prior, saved, value, conflicts, awaiting };
}

export function useSettingsDraft(key: string, saved: Config, available = true) {
  const [stored, setStored] = useState<Draft>({
    key,
    saved,
    value: saved,
    conflicts: [],
  });
  let state = stored;
  if (stored.key !== key) {
    state = { key, saved, value: saved, conflicts: [] };
    setStored(state);
  } else if (
    available &&
    JSON.stringify(stored.saved) !== JSON.stringify(saved)
  ) {
    state = reconcile(stored, saved);
    setStored(state);
  }
  return {
    draft: state.value,
    changed: JSON.stringify(state.value) !== JSON.stringify(state.saved),
    conflicts: state.conflicts,
    setDraft(value: Config) {
      setStored((prior) =>
        prior.key !== key
          ? prior
          : {
              ...prior,
              value,
              conflicts: prior.conflicts.filter(
                (group) => !same(value, prior.saved, group),
              ),
              awaiting: (prior.awaiting ?? []).filter(
                (group) =>
                  prior.pending ||
                  same(value, prior.value, group) ||
                  !same(value, prior.saved, group),
              ),
            },
      );
    },
    resolve(group: SettingGroup, useSaved: boolean) {
      setStored((prior) => ({
        ...prior,
        value: useSaved
          ? { ...prior.value, ...copy(prior.saved, group) }
          : prior.value,
        conflicts: prior.conflicts.filter((item) => item !== group),
        awaiting: (prior.awaiting ?? []).filter((item) => item !== group),
      }));
    },
    submitted(value: Config) {
      setStored((prior) => ({
        ...prior,
        value,
        submitted: value,
        awaiting: names.filter((group) => !same(value, prior.saved, group)),
        pending: true,
      }));
    },
    settled() {
      setStored((prior) => ({ ...prior, pending: false }));
    },
  };
}

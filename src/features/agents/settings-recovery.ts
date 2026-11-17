// Explicit repair of a confirmed settings snapshot. Launch validation stays strict.
import { artifactOp, artifactProblem } from "./agent-config-artifacts";
import { settingsProblem, type SettingRule } from "./agent-config";
import { revertTemplate } from "./agent-config-history";
import type { ConfigHistory } from "./service";

export function settingsRecovery(history: ConfigHistory | undefined) {
  const track = history?.sides.find((side) => side.side === "settings");
  const check = history?.settings;
  const head = track?.head;
  if (
    !track ||
    !head ||
    !check ||
    artifactOp(head) === "delete" ||
    artifactProblem(head, track.expected)
  )
    return;
  const body = JSON.parse(head.content) as {
    agentType?: unknown;
    settings: Record<string, unknown>;
    [key: string]: unknown;
  };
  if (body.agentType !== undefined && body.agentType !== check.agentType)
    return;
  const fields = Object.entries(body.settings).flatMap(([name, value]) => {
    const rule: SettingRule | undefined = Object.hasOwn(check.schema, name)
      ? check.schema[name]
      : undefined;
    return !rule ||
      typeof value !== "string" ||
      (Array.isArray(rule) && !rule.includes(value))
      ? [{ name, value, rule }]
      : [];
  });
  if (!fields.length) return;
  return { track, head, check, body, fields };
}
export type SettingsRecovery = NonNullable<ReturnType<typeof settingsRecovery>>;

/** Keep every other field and body extension, and revise exactly the displayed head. */
export function repairedSettings(
  recovery: SettingsRecovery,
  replacements: Record<string, string | undefined>,
) {
  const settings = Object.fromEntries(Object.entries(recovery.body.settings));
  for (const { name, rule } of recovery.fields) {
    if (!Object.hasOwn(replacements, name))
      throw new Error("Choose how to repair every setting");
    const value = replacements[name];
    if (value === undefined) delete settings[name];
    else {
      if (!rule) throw new Error("Unsupported fields must be removed");
      settings[name] = value;
    }
  }
  const problem = settingsProblem(recovery.check.schema, settings);
  if (problem) throw new Error(problem);
  const target = {
    ...recovery.head,
    content: JSON.stringify({ ...recovery.body, settings }),
  };
  return revertTemplate(
    recovery.track.expected,
    recovery.head,
    target,
    recovery.check,
  );
}

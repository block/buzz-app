export type Config = { model: string; effort: string; instructions: string };
export type Model = {
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
};
export const defaults: Config = { model: "", effort: "", instructions: "" };
export function parseConfig(raw: unknown): Config {
  const value =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [
      key,
      typeof value[key] === "string" ? value[key] : fallback,
    ]),
  ) as Config;
}
export const effortName = (effort: string) =>
  ({ xhigh: "Extra high", max: "Maximum", ultra: "Ultra" })[effort] ??
  `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`;

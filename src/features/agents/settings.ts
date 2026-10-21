// The settings a run captures, and the check that keeps superseded or blocked
// settings from ever prompting.

/** Everything a run's identity depends on, resolved together so no part can
 * come from a different resolution than another. */
export type AgentSettings<Config = unknown> = Readonly<{
  config: Config;
  /** The settings in `config` that came from the synced copy. A runtime
   * refuses one it doesn't support rather than default it (NIP-AP
   * "Settings"); local settings keep their fallbacks. */
  synced: Readonly<Record<string, string>>;
  /** The synced config revisions it resolved from; empty when local. */
  revisions: readonly string[];
  /** Why it can't run: a synced side failed to resolve, so `config` is only
   * the local row. Nothing prompts with it. */
  blocked?: string;
  name: string;
  /** A section for each team the agent is on, with the team's name, roster
   * and instructions; empty without one. */
  team: string;
}>;
/** Settings and the epoch they were applied at. A conversation keeps the
 * `Applied` it started with as its pin. */
export type Applied<Config = unknown> = Readonly<{
  settings: AgentSettings<Config>;
  epoch: number;
}>;
/** A run's settings, captured before anything it waits for. */
export type SettingsAttempt<Config = unknown> = Applied<Config> &
  Readonly<{
    /** Calls `send`, which must synchronously write the start or prompt, when
     * `selected` (the attempt's own settings or a conversation's pin) may
     * still run: the agent's epoch has not moved since either, and it is not
     * blocked. Otherwise throws `Refused` and calls nothing. A runtime calls
     * it immediately before each new prompt, never before a further wait. */
    handoff<T>(selected: Applied<Config>, send: () => T): T;
  }>;
/** A turn that must not run: its settings were superseded or blocked, or a
 * harness can't apply one of them. Shown as the turn's error. */
export class Refused extends Error {
  constructor(
    reason: string,
    readonly failure?: UnsupportedSetting,
  ) {
    super(reason);
    this.name = "Refused";
  }
}
/** A harness can't apply one of the selected settings, so the turn refuses
 * rather than run on its default. It concerns only that selection. */
export type UnsupportedSetting = Readonly<{
  kind: "unsupported-setting";
  setting: string;
  value: string;
  reason: string;
}>;
export const unsupportedSetting = (
  setting: string,
  value: string,
  reason: string,
) =>
  new Refused(reason, { kind: "unsupported-setting", setting, value, reason });
/** A refused turn's result: its reason, and what it couldn't apply. */
export const refusal = (error: Refused) => ({
  ok: false,
  error: error.message,
  ...(error.failure ? { failure: error.failure } : {}),
});
/** The team text and name a session opened with. They fence it only until
 * its first prompt is sent, which clears them: a session that has prompted
 * keeps them across a remote edit, and one that hasn't takes the newest. */
export type Inputs = { inputs?: string };
export const inputsOf = ({ settings }: Applied, name = settings.name) =>
  JSON.stringify([settings.team, name]);
/** Whether `live` may run on `current` inputs without being replaced. */
export const inputsFit = (live: Inputs, current: string) =>
  live.inputs === undefined || live.inputs === current;
export const SUPERSEDED =
  "This agent's settings changed before it started; send again";
/** Wraps `send` so the session counts as prompted once it is called. One
 * that hasn't prompted is refused when its inputs are no longer `current`'s. */
export const prompting =
  <T>(live: Inputs, current: () => string, send: () => T) =>
  () => {
    if (!inputsFit(live, current())) throw new Refused(SUPERSEDED);
    delete live.inputs;
    return send();
  };
/** The handoff for an agent whose epoch `epoch()` reads, and whose blocked
 * reason an `Applied` carries. */
export const handoffFor =
  (epoch: () => number | undefined, attempt: number) =>
  <T, C>(selected: Applied<C>, send: () => T): T => {
    const now = epoch();
    if (now !== attempt || selected.epoch !== attempt)
      throw new Refused(SUPERSEDED);
    if (selected.settings.blocked) throw new Refused(selected.settings.blocked);
    return send();
  };

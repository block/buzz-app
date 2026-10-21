// Settings packages and attempts for tests, against an epoch a test moves.
import {
  handoffFor,
  type AgentSettings,
  type Applied,
  type SettingsAttempt,
} from "./settings";

export const settingsOf = <C>(
  config: C,
  extra: Partial<Omit<AgentSettings<C>, "config">> = {},
): AgentSettings<C> =>
  Object.freeze({
    config,
    synced: {},
    revisions: [],
    name: "",
    team: "",
    ...extra,
  });

/** One agent's epoch, which `advance` moves as a Save or Restart would. */
export function settingsClock(initial = 0) {
  let epoch = initial;
  const clock = {
    get epoch() {
      return epoch;
    },
    advance() {
      return ++epoch;
    },
    applied: <C>(
      config: C,
      extra: Partial<Omit<AgentSettings<C>, "config">> = {},
      at = epoch,
    ): Applied<C> =>
      Object.freeze({ settings: settingsOf(config, extra), epoch: at }),
    attempt: <C>(
      config: C,
      extra: Partial<Omit<AgentSettings<C>, "config">> = {},
      at = epoch,
    ): SettingsAttempt<C> =>
      Object.freeze({
        ...clock.applied(config, extra, at),
        handoff: handoffFor(() => epoch, at),
      }),
  };
  return clock;
}

import type { ProposedSettings } from "./service";

/** `saved` with proposed model settings, resetting what a type's settings
 * screen would: a new provider's model, and a new provider's or model's
 * effort, unless the proposal names them too. */
export function withProposedSettings<
  Config extends Readonly<{ model: string; effort: string; provider?: string }>,
>(settings: ProposedSettings, saved: Config): Config {
  const provider = settings.provider ?? saved.provider;
  const sameProvider = provider === saved.provider;
  const model = settings.model ?? (sameProvider ? saved.model : "");
  const effort =
    settings.effort ??
    (sameProvider && model === saved.model ? saved.effort : "");
  return {
    ...saved,
    ...(provider !== undefined && { provider }),
    model,
    effort,
  };
}

import { Service, type Context } from "@deepseek-ai/cordis";
import { createContributions } from "../../plugins/contributions";
import type { ManagedProfile } from "./managed-profile";

/** Display-only identity context. Provider data never grants verification. */
export type ProfileSubject = Readonly<{
  community: string;
  viewer: string;
  pubkey: string;
  username: string;
}>;
export type ProfileProvider = Readonly<{
  id: string;
  matches(subject: ProfileSubject): boolean;
  /** Fetch only the signed-in subject. The host saves the result in their profile. */
  refresh(
    subject: ProfileSubject,
    signal: AbortSignal,
  ): Promise<ManagedProfile>;
}>;
export interface ProfileProviders {
  register(provider: ProfileProvider): void;
  snapshot(): readonly (ProfileProvider & { key: string })[];
  subscribe(listener: () => void): () => void;
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    profileProviders: ProfileProviders;
  }
}
export class ProfileProvidersService
  extends Service
  implements ProfileProviders
{
  private readonly providers;
  constructor(ctx: Context) {
    super(ctx, "profileProviders");
    this.providers = createContributions<ProfileProvider>(ctx);
  }
  snapshot = () => this.providers.snapshot();
  subscribe = (listener: () => void) => this.providers.subscribe(listener);
  register(provider: ProfileProvider) {
    if (
      !/^[a-z0-9][a-z0-9._-]*$/.test(provider.id) ||
      ![provider.matches, provider.refresh].every(
        (v) => typeof v === "function",
      )
    )
      throw new Error("Invalid profile provider");
    this.providers.register(this.ctx, provider);
  }
}

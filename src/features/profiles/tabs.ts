// Plugin-owned tabs on a person's profile panel. Agents have their own:
// `agents.registerTab`.
import { Service, type Context } from "@deepseek-ai/cordis";
import type { ComponentType } from "react";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";
import type { Profile } from "../relay/contracts";

export type ProfileTabProps = {
  pubkey: string;
  /** The profile as the panel shows it; absent until it loads. Its `verified`
   * name is the relay's assertion, never account access. */
  profile?: Profile | undefined;
  /** Opens a link, such as another profile, where the panel is shown; false
   * when it can't there. */
  open(target: string): boolean;
  canOpen(target: string): boolean;
};
export type ProfileTab = Readonly<{
  id: string;
  title: string;
  component: ComponentType<ProfileTabProps>;
  /** Whether the tab shows for this person; absent, it shows for everyone. */
  when?: (pubkey: string, profile: Profile | undefined) => boolean;
}>;
export type RegisteredProfileTab = Contribution<ProfileTab>;
export type ProfileTabs = {
  /** Adds a tab after Info on people's profiles while the plugin is on. */
  register(tab: ProfileTab): void;
  snapshot(): readonly RegisteredProfileTab[];
  subscribe(listener: () => void): () => void;
};

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Optional in API v1: read it with `ctx.reflect.get("profileTabs")`. */
    profileTabs?: ProfileTabs;
  }
}

export class ProfileTabsService extends Service implements ProfileTabs {
  private readonly tabs;
  constructor(ctx: Context) {
    super(ctx, "profileTabs");
    this.tabs = createContributions<ProfileTab>(ctx);
  }
  snapshot = () => this.tabs.snapshot();
  subscribe = (listener: () => void) => this.tabs.subscribe(listener);
  register(tab: ProfileTab) {
    if (
      !/^[a-z0-9][a-z0-9._-]*$/.test(tab?.id ?? "") ||
      typeof tab.title !== "string" ||
      !tab.title.trim() ||
      typeof tab.component !== "function" ||
      (tab.when !== undefined && typeof tab.when !== "function")
    )
      throw new Error("Profile tabs need an id, a title and a component");
    this.tabs.register(this.ctx, tab);
  }
}

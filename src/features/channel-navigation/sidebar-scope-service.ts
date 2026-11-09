import { Service, type Context } from "@deepseek-ai/cordis";
import type { ComponentType } from "react";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";

/** While registered, the sidebar shows only Solo: the All/Solo/Team tabs and
 * page destinations give way to `banner`, and the saved tab returns after.
 * Search and links still open any conversation. */
export type SidebarRestriction = Readonly<{
  id: string;
  scope: "solo";
  banner: ComponentType;
}>;
export type RegisteredSidebarRestriction = Contribution<SidebarRestriction>;
/** PROTOTYPE: while registered, Messages shows another sidebar in place of
 * its own. "activity" lists conversations newest first (the Activity
 * sidebar plugin). */
export type SidebarView = Readonly<{ id: string; sidebar: "activity" }>;
export type SidebarScope = Readonly<{
  snapshot(): readonly RegisteredSidebarRestriction[];
  subscribe(listener: () => void): () => void;
  /** Returns a remover; disabling the plugin removes it too. */
  restrict(restriction: SidebarRestriction): () => void;
  views?(): readonly Contribution<SidebarView>[];
  subscribeViews?(listener: () => void): () => void;
  /** Returns a remover; disabling the plugin removes it too. */
  replaceSidebar?(view: SidebarView): () => void;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    sidebarScope: SidebarScope;
  }
}

export class SidebarScopeService extends Service implements SidebarScope {
  private readonly restrictions;
  private readonly replacements;
  constructor(ctx: Context) {
    super(ctx, "sidebarScope");
    this.restrictions = createContributions<SidebarRestriction>(ctx);
    this.replacements = createContributions<SidebarView>(ctx);
  }
  views = () => this.replacements.snapshot();
  subscribeViews = (listener: () => void) =>
    this.replacements.subscribe(listener);
  replaceSidebar(view: SidebarView) {
    if (
      !view ||
      typeof view.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(view.id) ||
      view.sidebar !== "activity"
    )
      throw new Error("A sidebar view needs an id and a known sidebar");
    return this.replacements.register(this.ctx, view);
  }
  snapshot = () => this.restrictions.snapshot();
  subscribe = (listener: () => void) => this.restrictions.subscribe(listener);
  restrict(restriction: SidebarRestriction) {
    if (
      !restriction ||
      typeof restriction.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(restriction.id) ||
      restriction.scope !== "solo" ||
      typeof restriction.banner !== "function"
    )
      throw new Error("A sidebar restriction needs an id, scope and banner");
    return this.restrictions.register(this.ctx, restriction);
  }
}

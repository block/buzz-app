import { Service, type Context } from "@deepseek-ai/cordis";
import type { ComponentType } from "react";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";

/** While registered, the All/Solo/Team tabs give way to `banner` and the saved
 * tab returns after. `solo` shows only Solo and hides page destinations; `all`
 * keeps the combined inventory and page destinations, and `banner` is
 * optional. A `solo` restriction wins over an `all` one. Search and links
 * still open any conversation. */
export type SidebarRestriction = Readonly<
  { id: string } & (
    | { scope: "solo"; banner: ComponentType }
    | { scope: "all"; banner?: ComponentType }
  )
>;
export type RegisteredSidebarRestriction = Contribution<SidebarRestriction>;
export type SidebarScope = Readonly<{
  snapshot(): readonly RegisteredSidebarRestriction[];
  subscribe(listener: () => void): () => void;
  /** Returns a remover; disabling the plugin removes it too. */
  restrict(restriction: SidebarRestriction): () => void;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    sidebarScope: SidebarScope;
  }
}

export class SidebarScopeService extends Service implements SidebarScope {
  private readonly restrictions;
  constructor(ctx: Context) {
    super(ctx, "sidebarScope");
    this.restrictions = createContributions<SidebarRestriction>(ctx);
  }
  snapshot = () => this.restrictions.snapshot();
  subscribe = (listener: () => void) => this.restrictions.subscribe(listener);
  restrict(restriction: SidebarRestriction) {
    if (
      !restriction ||
      typeof restriction.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(restriction.id) ||
      (restriction.scope !== "solo" && restriction.scope !== "all") ||
      (restriction.banner === undefined
        ? restriction.scope === "solo"
        : typeof restriction.banner !== "function")
    )
      throw new Error(
        "A sidebar restriction needs an id, a solo or all scope, and a solo banner",
      );
    return this.restrictions.register(this.ctx, restriction);
  }
}

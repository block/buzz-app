import { Service, type Context } from "@deepseek-ai/cordis";
import type { OpenTarget } from "../navigation/targets";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions.ts";
import type {
  SidebarSectionContribution,
  SidebarSectionRow,
} from "./sidebar-sections-service";

/** A title row, and optionally a few rows, above the sidebar's sections. */
export type SidebarHeaderContribution = Readonly<{
  version: 1;
  id: string;
  title: string;
  /** Runs when the title row is selected. */
  onTitle: () => void | Promise<void>;
  rows?: SidebarSectionContribution["rows"];
  /** Required with `rows`: the destination each row opens and selects on. */
  select?: (row: SidebarSectionRow) => OpenTarget;
}>;

export type RegisteredSidebarHeader = Contribution<SidebarHeaderContribution>;
export type SidebarHeader = Readonly<{
  version: 1;
  snapshot: () => readonly RegisteredSidebarHeader[];
  subscribe: (listener: () => void) => () => void;
  register: (header: SidebarHeaderContribution) => void;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Read with `ctx.reflect.get("sidebarHeader")` for old-host compatibility. */
    sidebarHeader?: SidebarHeader;
  }
}

export class SidebarHeaderService extends Service implements SidebarHeader {
  private readonly contributions;
  readonly version = 1 as const;

  constructor(ctx: Context) {
    super(ctx, "sidebarHeader");
    this.contributions = createContributions<SidebarHeaderContribution>(ctx);
  }

  snapshot = () => this.contributions.snapshot();
  subscribe = (listener: () => void) => this.contributions.subscribe(listener);

  register(header: SidebarHeaderContribution) {
    if (header?.version !== 1) {
      console.warn("Ignoring unsupported sidebar header contribution version");
      return;
    }
    if (
      typeof header.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(header.id) ||
      typeof header.title !== "string" ||
      !header.title.trim() ||
      typeof header.onTitle !== "function" ||
      (header.rows !== undefined &&
        (!header.rows ||
          typeof header.rows.snapshot !== "function" ||
          typeof header.rows.subscribe !== "function" ||
          typeof header.select !== "function"))
    )
      throw new Error("A sidebar header needs an id, title and onTitle action");
    this.contributions.register(this.ctx, header);
  }
}

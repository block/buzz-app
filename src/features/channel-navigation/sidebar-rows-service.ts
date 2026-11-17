import { Service, type Context } from "@deepseek-ai/cordis";
import type { ReactElement } from "react";
import type { ChannelSummary } from "../relay/contracts";
import type { UnreadSnapshot } from "../relay/unread";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";

export type SidebarRow = Readonly<{
  id: string;
  kind: "team" | "dm" | "solo";
  label: string;
  /** Team section key, or Solo workspace id ("" for unfiled chats). */
  sectionKey: string;
  channel: ChannelSummary;
  unread: UnreadSnapshot;
}>;
export type SidebarRowContribution = Readonly<{
  version: 1;
  id: string;
  render?: (
    row: SidebarRow,
    Default: ReactElement | null,
  ) => ReactElement | null;
}>;
export type RegisteredSidebarRows = Contribution<SidebarRowContribution>;
export type SidebarRows = Readonly<{
  version: 1;
  snapshot: () => readonly RegisteredSidebarRows[];
  subscribe: (listener: () => void) => () => void;
  settled?: () => boolean;
  register: (contribution: SidebarRowContribution) => void;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Read through reflect for compatibility with hosts without row contributions. */
    sidebarRows?: SidebarRows;
  }
}

const idPattern = /^[a-z0-9][a-z0-9._-]*$/;

export class SidebarRowsService extends Service implements SidebarRows {
  readonly version = 1 as const;
  private readonly contributions;
  private source: readonly RegisteredSidebarRows[] = [];
  private ordered: readonly RegisteredSidebarRows[] = [];

  constructor(ctx: Context) {
    super(ctx, "sidebarRows");
    this.contributions = createContributions<SidebarRowContribution>(ctx);
  }

  snapshot = () => {
    const source = this.contributions.snapshot();
    if (source !== this.source) {
      this.source = source;
      this.ordered = Object.freeze(
        [...source].sort((a, b) =>
          a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
        ),
      );
    }
    return this.ordered;
  };
  settled = () => this.ctx.pluginStatus.settled?.() ?? true;
  subscribe = (listener: () => void) => {
    const contributions = this.contributions.subscribe(listener);
    // A failed plugin can settle without changing the contribution snapshot.
    const status = this.ctx.pluginStatus.subscribe(listener);
    return () => {
      contributions();
      status();
    };
  };

  register(value: SidebarRowContribution) {
    if (value?.version !== 1) {
      console.warn("Ignoring unsupported sidebar row contribution version");
      return;
    }
    if (
      typeof value.id !== "string" ||
      !idPattern.test(value.id) ||
      (value.render !== undefined && typeof value.render !== "function")
    )
      throw new Error("Invalid sidebar row contribution");
    this.contributions.register(this.ctx, value);
  }
}

export function sidebarRow(
  channel: ChannelSummary,
  sectionKey: string,
  unread: UnreadSnapshot,
): SidebarRow {
  return {
    id: channel.id,
    kind:
      channel.channelType === "dm"
        ? "dm"
        : channel.channelType === "solo"
          ? "solo"
          : "team",
    label: channel.name,
    sectionKey,
    channel,
    unread,
  };
}

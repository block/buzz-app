export type SoloTaskStatus =
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "archived";
export type SoloViewOptions = Readonly<{
  group: "workspace" | "status" | "none";
  sort: "recent" | "name";
  show: "all-chats" | "active-tasks" | "all-tasks";
}>;
export type SoloTaskRow = Readonly<{
  channelId: string;
  parentChannelId?: string;
  status: SoloTaskStatus;
  subtitle?: string;
  details?: readonly Readonly<{ label: string; value: string }>[];
}>;
export type SoloNavigationBinding = Readonly<{ scope: string; viewer: string }>;
/** Metadata only. The host owns destinations, titles, placement and rendering. */
export type SoloEnhancement = Readonly<{
  id: string;
  order?: number;
  title: string;
  childNoun: Readonly<{ one: string; other: string }>;
  subscribe(listener: () => void): () => void;
  dataRevision(): number;
  read(binding: SoloNavigationBinding): { rows: readonly SoloTaskRow[] };
  create?: Readonly<{
    label: string;
    run(binding: SoloNavigationBinding): void | Promise<void>;
  }>;
}>;
export type SoloNavigation = Readonly<{
  /** Also certifies the optional sixth active gate on channelWrites.create. */
  version: 1;
  register(enhancement: SoloEnhancement): void;
}>;
declare module "@deepseek-ai/cordis" {
  interface Context {
    soloNavigation: SoloNavigation;
  }
}

import { Service, type Context } from "@deepseek-ai/cordis";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";

export type NewMenuItem = Readonly<{
  id: string;
  title: string;
  group: "solo" | "team";
  run: () => void | Promise<void>;
}>;
export type RegisteredNewMenuItem = Contribution<NewMenuItem>;
export type NewMenuItems = Readonly<{
  snapshot(): readonly RegisteredNewMenuItem[];
  subscribe(listener: () => void): () => void;
  register(item: NewMenuItem): void;
}>;
declare module "@deepseek-ai/cordis" {
  interface Context {
    newMenu?: NewMenuItems;
  }
}

export class NewMenuService extends Service implements NewMenuItems {
  private readonly items;
  constructor(ctx: Context) {
    super(ctx, "newMenu");
    this.items = createContributions<NewMenuItem>(ctx);
  }
  snapshot = () => this.items.snapshot();
  subscribe = (listener: () => void) => this.items.subscribe(listener);
  register(item: NewMenuItem) {
    if (
      !item ||
      typeof item.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(item.id) ||
      typeof item.title !== "string" ||
      !item.title.trim() ||
      (item.group !== "solo" && item.group !== "team") ||
      typeof item.run !== "function"
    )
      throw new Error(
        'A New menu item needs an id, title, group ("solo" or "team") and run function',
      );
    this.items.register(this.ctx, item);
  }
}

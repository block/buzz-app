// FOUNDATION: Target-based panel contributions, independent of page layout.
import { Service, type Context } from "@deepseek-ai/cordis";
import type { ComponentType } from "react";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";

export type PanelProps = {
  close(): void;
  target: string;
};
export type Panel = Readonly<{
  id: string;
  title: string;
  matches: (url: string) => boolean;
  // Optional host launcher; placement stays with the current page or host fallback.
  launcher?: Readonly<{ icon: string; target: string }>;
  component: ComponentType<PanelProps>;
}>;
export type RegisteredPanel = Contribution<Panel>;
export type Panels = {
  register(panel: Panel): void;
  resolve(target: string): RegisteredPanel | undefined;
  snapshot(): readonly RegisteredPanel[];
  subscribe(listener: () => void): () => void;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    panels: Panels;
  }
}
export class PanelsService extends Service implements Panels {
  private readonly panels;
  constructor(ctx: Context) {
    super(ctx, "panels");
    this.panels = createContributions<Panel>(ctx);
  }
  snapshot = () => this.panels.snapshot();
  subscribe = (listener: () => void) => this.panels.subscribe(listener);
  resolve = (target: string) =>
    this.panels.snapshot().find((panel) => {
      try {
        return panel.matches(target);
      } catch {
        return false;
      }
    });
  register(panel: Panel) {
    if (
      !panel ||
      typeof panel.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(panel.id) ||
      typeof panel.title !== "string" ||
      !panel.title.trim() ||
      typeof panel.matches !== "function" ||
      typeof panel.component !== "function"
    ) {
      throw new Error("A panel needs an id, title, matcher, and component");
    }
    if (
      panel.launcher !== undefined &&
      (!panel.launcher ||
        typeof panel.launcher.icon !== "string" ||
        !panel.launcher.icon.trim() ||
        typeof panel.launcher.target !== "string")
    ) {
      throw new Error("A panel launcher needs an icon and target string");
    }
    this.panels.register(this.ctx, {
      ...panel,
      ...(panel.launcher && { launcher: Object.freeze({ ...panel.launcher }) }),
    });
  }
}

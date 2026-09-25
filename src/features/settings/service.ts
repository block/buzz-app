// Plugin-owned cards inside existing host Settings. No persistence.
import { Service, type Context } from "@deepseek-ai/cordis";
import type { ComponentType } from "react";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";
export type SettingsCard = {
  id: string;
  title: string;
  component: ComponentType<{ active(): boolean }>;
  /** Show this card under a labelled account-level group instead of the selected community. */
  group?: string;
};
export type SettingsCards = {
  snapshot(): readonly Contribution<SettingsCard>[];
  subscribe(listener: () => void): () => void;
  register(card: SettingsCard): void;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    settingsCards: SettingsCards;
  }
}
export class SettingsCardsService extends Service implements SettingsCards {
  private readonly entries;
  constructor(ctx: Context) {
    super(ctx, "settingsCards");
    this.entries = createContributions<SettingsCard>(ctx);
  }
  snapshot = () => this.entries.snapshot();
  subscribe = (listener: () => void) => this.entries.subscribe(listener);
  register(card: SettingsCard) {
    if (
      !/^[a-z0-9][a-z0-9._-]*$/.test(card.id) ||
      !card.title?.trim() ||
      typeof card.component !== "function" ||
      (card.group !== undefined &&
        (typeof card.group !== "string" || !card.group.trim()))
    )
      throw new Error("Settings cards need an id, title and component");
    this.entries.register(this.ctx, card);
  }
}

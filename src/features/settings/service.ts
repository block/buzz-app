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
  component: ComponentType<{
    active(): boolean;
    community?: { id: string; name: string };
  }>;
  /** Show this card under a labelled account-level group instead of the selected community. */
  group?: string;
  /** Separate permission-gated controls from ordinary settings for the selected community. */
  section?: "administration";
  /** Reactive verified authorization for permission-gated navigation. */
  visibility?: {
    snapshot(): boolean;
    subscribe(listener: () => void): () => void;
    ensure(): () => void;
  };
};
export type SettingsCards = {
  snapshot(): readonly Contribution<SettingsCard>[];
  subscribe(listener: () => void): () => void;
  register(card: SettingsCard): void;
  retainVisibility(): () => void;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    settingsCards: SettingsCards;
  }
}
export class SettingsCardsService extends Service implements SettingsCards {
  private readonly entries;
  private readonly listeners = new Set<() => void>();
  private visible: readonly Contribution<SettingsCard>[] = [];
  constructor(ctx: Context) {
    super(ctx, "settingsCards");
    this.entries = createContributions<SettingsCard>(ctx);
    ctx.effect(() => this.entries.subscribe(this.publish));
  }
  private publish = () => {
    const next = this.entries
      .snapshot()
      .filter((entry) => entry.visibility?.snapshot() !== false);
    if (
      next.length === this.visible.length &&
      next.every((entry, index) => entry === this.visible[index])
    )
      return;
    this.visible = Object.freeze(next);
    for (const listener of this.listeners) listener();
  };
  snapshot = () => this.visible;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  retainVisibility() {
    const releases = this.entries
      .snapshot()
      .flatMap((entry) =>
        entry.visibility ? [entry.visibility.ensure()] : [],
      );
    return () => {
      for (const release of releases) release();
    };
  }
  register(card: SettingsCard) {
    if (
      !/^[a-z0-9][a-z0-9._-]*$/.test(card.id) ||
      !card.title?.trim() ||
      typeof card.component !== "function" ||
      (card.group !== undefined &&
        (typeof card.group !== "string" || !card.group.trim())) ||
      (card.section !== undefined && card.section !== "administration") ||
      (card.group !== undefined && card.section !== undefined) ||
      (card.visibility !== undefined &&
        (typeof card.visibility.snapshot !== "function" ||
          typeof card.visibility.subscribe !== "function" ||
          typeof card.visibility.ensure !== "function"))
    )
      throw new Error("Settings cards need an id, title and component");
    this.entries.register(this.ctx, card);
    if (card.visibility) {
      const visibility = card.visibility;
      this.ctx.effect(() => visibility.subscribe(this.publish));
    }
    this.publish();
  }
}

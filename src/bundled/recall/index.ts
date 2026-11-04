// buzz-recall: when an agent starts a turn, put the few past messages and memories that help in front of it.
import type { PluginModule } from "../../plugins/api";
import { card } from "./card.tsx";
import { createEmbeddings, type EmbeddingHost } from "./embed.ts";
import { recall } from "./recall.ts";
import { load } from "./settings.ts";
import type { DecisionRequest, DecisionResult } from "./types.ts";

export const inject = ["react", "agents", "decisions", "settingsCards", "host"];

/** The host itself, never its detached methods: each call must stay a method call to keep the plugin's scope. */
const embeddable = (host: Partial<EmbeddingHost>): host is EmbeddingHost =>
  typeof host.request === "function";

export const apply: PluginModule["apply"] = (ctx) => {
  // The host owns transport support and network policy.
  const semantic = embeddable(ctx.host)
    ? createEmbeddings(ctx.host, load)
    : undefined;
  if (semantic) {
    ctx.effect(() => () => semantic.disable());
  }
  ctx.agents.registerTurnContext({
    id: "recall",
    run: (turn) =>
      recall(turn, { settings: load, decide, now: Date.now, semantic }),
  });
  ctx.settingsCards.register({
    id: "settings",
    title: "Recall",
    group: "Plugins",
    component: card(ctx.react, ctx.decisions, semantic),
  });

  // Ask only a provider that can answer now: one still checking or needing setup would only spend the deadline.
  // `unconfirmed` (say, a locked keychain) may still answer, and the deadline bounds it.
  function decide(request: DecisionRequest): Promise<DecisionResult> {
    const status = ctx.decisions.status();
    return status === "ready" || status === "unconfirmed"
      ? ctx.decisions.decide(request)
      : Promise.resolve({
          outcome: "failed",
          backend: undefined,
          reason: "unavailable",
        });
  }
};

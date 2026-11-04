import type { Decisions } from "../../features/decisions/service";
// The Settings card: where recall searches, and whether it may show memories where others can read.
//
// API v1 plugins get React from the host (classic JSX, so `React` must be in scope) and no component SDK,
// so the card uses the host's Settings CSS roles over plain, accessible markup.
import type * as ReactModule from "react";
import type { Embeddings } from "./embed.ts";
import { embeddingCard } from "./embed-card.tsx";
import { load, save } from "./settings.ts";
import type { Settings } from "./types.ts";

/** The slice of `ctx.decisions` the card shows. */
export type ProviderStatus = Pick<Decisions, "status" | "subscribe">;

export function card(
  React: typeof ReactModule,
  decisions: ProviderStatus,
  embeddings?: Embeddings,
) {
  const EmbeddingCard = embeddings
    ? embeddingCard(React, embeddings)
    : undefined;
  function Toggle(props: {
    label: string;
    description: string;
    checked: boolean;
    onChange(on: boolean): void;
  }) {
    const id = React.useId();
    return (
      <div className="buzz-preference-row">
        <div className="buzz-preference-row-content">
          <label htmlFor={id} className="buzz-preference-row-label">
            {props.label}
          </label>
          <span id={`${id}-d`} className="buzz-preference-row-description">
            {props.description}
          </span>
        </div>
        <div className="buzz-preference-row-trailing">
          <button
            id={id}
            type="button"
            role="switch"
            aria-checked={props.checked}
            aria-describedby={`${id}-d`}
            className="buzz-switch-control"
            data-checked={props.checked ? "" : undefined}
            onClick={() => props.onChange(!props.checked)}
          >
            <span className="buzz-switch-thumb" />
          </button>
        </div>
      </div>
    );
  }

  return function RecallSettings({ active }: { active(): boolean }) {
    const [settings, setSettings] = React.useState(load);
    const status = React.useSyncExternalStore(
      decisions.subscribe,
      decisions.status,
    );
    const set = (change: Partial<Settings>) => {
      if (!active()) return;
      const next = { ...load(), ...change };
      save(next);
      setSettings(next);
    };
    return (
      <section aria-label="Recall settings">
        <div className="buzz-content-header">
          <div className="buzz-content-header-copy">
            <h2 className="buzz-content-header-title">Recall</h2>
            <p className="buzz-content-header-subtitle">
              When an agent starts a turn, recall finds past messages and
              memories that might help, asks your Decisions provider which ones
              do, and quotes those few to the agent.
            </p>
          </div>
        </div>
        <div className="buzz-settings-group" data-layout="rows">
          <Toggle
            label="Search the whole relay"
            description="Off: only the channel the agent is answering in. On: every channel the agent can read. A message is never shown where someone could read it who couldn't read the original."
            checked={settings.scope === "relay"}
            onChange={(on) => set({ scope: on ? "relay" : "channel" })}
          />
          <Toggle
            label="Recall memories in channels other people can read"
            description="Off: memories are recalled only in chats with just you and the agent."
            checked={settings.sharedMemories}
            onChange={(on) => set({ sharedMemories: on })}
          />
        </div>
        {EmbeddingCard && <EmbeddingCard active={active} />}
        <p role="status" className="buzz-preference-row-description">
          {status === "ready"
            ? "Your Decisions provider is ready."
            : "Recall shows nothing until a Decisions provider is set up in Settings."}
        </p>
      </section>
    );
  };
}

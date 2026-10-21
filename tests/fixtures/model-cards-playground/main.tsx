import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentChoice } from "../../../src/features/messages/ComposerModels";
import {
  AgentsContext,
  type MentionModelChoice,
} from "../../../src/features/agents/react";
import type {
  Agents,
  SessionState,
} from "../../../src/features/agents/service";
import type { RunPick } from "../../../src/features/relay/messages";
import { Button } from "../../../src/shared/design-system/ui/Button";
import { Select } from "../../../src/shared/design-system/ui/Select";
import { createAppearance } from "../../../src/shared/theme/service";
import { useKeyboardFocusVisibility } from "../../../src/shared/design-system/useKeyboardFocusVisibility";
import "../../../src/shared/styles/globals.css";
import "./style.css";
import bestie from "../../../public/bestie.png";
const appearance = createAppearance();
const efforts = [
  "Minimal",
  "Low",
  "Medium",
  "High",
  "Extra high",
  "Maximum",
].map((label) => ({ id: label.toLowerCase(), label }));
const models = [
  { id: "sol", label: "GPT-6.1-Sol", effort: "medium", efforts },
  {
    id: "luna",
    label: "GPT-5.6-Luna",
    effort: "low",
    efforts: efforts.slice(1, 4),
  },
  { id: "plain", label: "Standard", efforts: [] },
];
const cases: {
  label: string;
  name?: string;
  state?: SessionState;
  loading?: boolean;
  disabled?: boolean;
  noSession?: boolean;
  single?: boolean;
  plain?: boolean;
  unknown?: boolean;
  effort?: string;
  fails?: boolean;
  artwork?: boolean;
}[] = [
  { label: "Idle · all effort levels", name: "Atlas", artwork: true },
  { label: "Working · interrupt available", name: "Pollen", state: "active" },
  {
    label: "Compacting · interrupt or finish",
    name: "Honey",
    state: "compacting",
  },
  { label: "Unavailable · explanatory tooltips", state: "unavailable" },
  { label: "Loading model catalog", loading: true },
  { label: "Action failure · retry after clearing failure", fails: true },
  {
    label: "Disabled model and effort controls",
    disabled: true,
    noSession: true,
  },
  { label: "Single model · fixed model label", single: true },
  { label: "No thinking levels · model only", plain: true },
  { label: "No session controls", noSession: true },
  { label: "Unknown default effort", unknown: true },
  { label: "Minimum effort", effort: "minimal" },
  { label: "Maximum effort", effort: "maximum" },
  {
    label: "Long agent name",
    name: "A very long agent name that needs to remain readable beside session controls",
  },
];
const emptyTypes: never[] = [];
function Example({
  item,
  index,
}: {
  item: (typeof cases)[number];
  index: number;
}) {
  const [picks, setPicks] = useState<RunPick>(
    item.effort ? { effort: item.effort } : {},
  );
  const [fail, setFail] = useState(!!item.fails);
  const [loading, setLoading] = useState(!!item.loading);
  const [state, setState] = useState<SessionState>(item.state ?? "idle");
  const service = useMemo(() => {
    let current: SessionState = item.state ?? "idle";
    let finish: (() => void) | undefined;
    const listeners = new Set<() => void>();
    const update = (next: SessionState) => {
      current = next;
      setState(next);
      for (const fn of listeners) fn();
    };
    return {
      agents: {
        types: () => emptyTypes,
        subscribe: (fn: () => void) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        sessionState: () => current,
        session: async (_key: string, _place: unknown, action: string) => {
          if (fail)
            throw new Error(
              "Could not reach the agent. Clear failure and try again.",
            );
          if (action === "compact") {
            update("compacting");
            await new Promise<void>((resolve) => {
              finish = resolve;
            });
          } else {
            finish?.();
            finish = undefined;
            update("idle");
          }
        },
      } as unknown as Agents,
      complete: () => {
        finish?.();
        finish = undefined;
        update("idle");
      },
      reset: () => {
        finish?.();
        finish = undefined;
        update(item.state ?? "idle");
      },
    };
  }, [fail, item]);
  const choice: MentionModelChoice = {
    pubkey: String(index).padStart(64, "0"),
    name: item.name ?? "Honey",
    current: "sol",
    models: item.plain
      ? models.slice(2)
      : item.single
        ? models.slice(0, 1)
        : models,
    loading,
    ...(!item.noSession ? { session: "channel" as const } : {}),
  };
  const displayedChoice = item.unknown
    ? {
        ...choice,
        models: choice.models.map(({ effort: _, ...model }) => model),
      }
    : choice;
  return (
    <section className="example">
      <div className="caption">
        <h2>
          {String(index + 1).padStart(2, "0")} / {item.label}
        </h2>
        <span>{state}</span>
      </div>
      <AgentsContext.Provider value={service.agents}>
        <AgentChoice
          choice={displayedChoice}
          avatarSrc={item.artwork ? bestie : undefined}
          place={{ channelId: "offline" }}
          value={picks}
          disabled={!!item.disabled}
          pick={setPicks}
        />
      </AgentsContext.Provider>
      <div className="example-controls">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setPicks(item.effort ? { effort: item.effort } : {});
            service.reset();
          }}
        >
          Reset
        </Button>
        {(state === "active" || state === "compacting") && (
          <Button size="sm" variant="subtle" onClick={service.complete}>
            Finish simulated work
          </Button>
        )}
        {item.loading && (
          <Button
            size="sm"
            variant="subtle"
            onClick={() => setLoading(!loading)}
          >
            {loading ? "Resolve catalog" : "Load again"}
          </Button>
        )}
        {item.fails && (
          <Button size="sm" variant="subtle" onClick={() => setFail(!fail)}>
            {fail ? "Clear failure" : "Enable failure"}
          </Button>
        )}
        <output>
          {picks.model ?? "Default model"} · {picks.effort ?? "Default effort"}
        </output>
      </div>
    </section>
  );
}
function App() {
  useKeyboardFocusVisibility();
  const [width, setWidth] = useState("376");
  const [mode, setMode] = useState(appearance.snapshot().mode);
  const [scale, setScale] = useState("1");
  return (
    <main className="playground">
      <header className="intro">
        <p className="text-caption">BUZZ / INTERACTIVE COMPONENT PLAYGROUND</p>
        <h1 className="text-title">Agent model cards</h1>
        <p>
          Real cards, local sample data. Drag the avatar, choose a model, and
          try session actions. No agent runs or relay writes.
        </p>
        <div className="toolbar">
          <Select
            label="Theme"
            value={mode}
            groups={[
              {
                label: "Theme",
                options: [
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                ],
              },
            ]}
            onValueChange={(v) => {
              setMode(v as "light" | "dark");
              appearance.setMode(v as "light" | "dark");
            }}
          />
          <Select
            label="Card width"
            value={width}
            groups={[
              {
                label: "Width",
                options: [
                  { value: "280", label: "Narrow" },
                  { value: "376", label: "Default" },
                  { value: "560", label: "Wide" },
                ],
              },
            ]}
            onValueChange={setWidth}
          />
          <Select
            label="Text size"
            value={scale}
            groups={[
              {
                label: "Size",
                options: [
                  { value: "1", label: "100%" },
                  { value: "1.5", label: "150%" },
                  { value: "2", label: "200%" },
                ],
              },
            ]}
            onValueChange={(v) => {
              setScale(v);
              appearance.setFontScale(Number(v));
            }}
          />
        </div>
      </header>
      <div className="stack" style={{ width: Number(width) }}>
        {cases.map((item, index) => (
          <Example key={item.label} item={item} index={index} />
        ))}
      </div>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing playground root");
createRoot(root).render(<App />);

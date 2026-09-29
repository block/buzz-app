import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { ActivityDetails } from "../../src/bundled/agent-activity/ActivityPanel";
import { ActivityStream } from "../../src/bundled/agent-activity/ActivityStream";
import { ActivityDisclosure } from "../../src/bundled/agent-activity/ActivityDisclosure";
import { ActivityFeedStatus } from "../../src/bundled/agent-activity/ActivityFeedStatus";
import { ThreadAgentGroup } from "../../src/features/messages/ThreadAgentGroup";
import type { ChannelMessage } from "../../src/features/relay/contracts";
import { activityRecords } from "../../src/features/agents/activity-records";
import { Button } from "../../src/shared/design-system/ui/Button";
import { Avatar } from "../../src/shared/design-system/ui/Avatar";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import {
  agent,
  peer,
  channel,
  response,
  scenarios,
  fixture,
  type Scenario,
} from "./playground-data";
import "../../src/shared/styles/globals.css";
import "./playground.css";

const surfaces = ["Inline", "Panel", "Profile", "Response"] as const;
type Surface = (typeof surfaces)[number];
function Experience({
  scenario,
  surface,
}: {
  scenario: Scenario;
  surface: Surface;
}) {
  const data = useMemo(() => fixture(scenario), [scenario]);
  useEffect(() => data.dispose, [data]);
  const [expanded, expand] = useState(false);
  const snapshot = useSyncExternalStore(
    data.session.agentActivity.subscribe,
    data.session.agentActivity.snapshot,
  );
  const records = activityRecords(snapshot.records, agent, channel);
  if (surface !== "Inline")
    return (
      <ActivityDetails
        session={data.session}
        selection={{
          agent,
          channelId: channel,
          ...(surface === "Profile" ? { view: "profile" as const } : {}),
          ...(surface === "Response" ? { messageId: response } : {}),
        }}
      />
    );
  const activity = (
    <>
      <ActivityFeedStatus
        status={snapshot.status}
        trimmed={snapshot.trimmed}
        retry={data.session.live.retry}
      />
      <ActivityStream
        session={data.session}
        records={records}
        turns={snapshot.turns.filter((turn) => turn.agent === agent)}
        compact
        showTurnHeading={false}
        showDiagnostics={false}
      />
    </>
  );
  return (
    <div className="lab-conversation">
      <div className="lab-person">
        <Avatar fallback="Alex" alt="Alex" />
        <div>
          <p className="text-label-sm">
            Alex <span className="text-caption text-subtle">· 10:42</span>
          </p>
          <p className="text-body-sm">
            Check the composer retry path and tell me what you find.
          </p>
        </div>
      </div>
      {scenario === "coordination" ? (
        <ThreadAgentGroup
          session={data.session}
          profiles={data.profiles}
          block={{
            kind: "agents",
            id: "sample",
            agents: [agent, peer],
            rows: [
              {
                id: "agent",
                authorId: agent,
                content: "Please verify the retry behavior.",
              },
              {
                id: "peer",
                authorId: peer,
                content: "Checked it. The selected agent is preserved.",
              },
            ] as ChannelMessage[],
            tail: false,
          }}
          coordination={(row) => (
            <div className="lab-coordination text-body-sm">
              <p>{row.content}</p>
            </div>
          )}
        >
          <ActivityDisclosure
            label="View activity"
            expanded={expanded}
            onExpand={expand}
          >
            {activity}
          </ActivityDisclosure>
        </ThreadAgentGroup>
      ) : (
        <div className="lab-person">
          <Avatar fallback="Rivet" alt="Rivet" shape="squircle" />
          <div className="lab-activity">
            <p className="text-label-sm">Rivet</p>
            <ActivityDisclosure
              label={
                snapshot.turns[0]?.state === "working"
                  ? "Working"
                  : snapshot.turns[0]?.state === "unknown"
                    ? "Status unknown"
                    : "View activity"
              }
              expanded={expanded}
              onExpand={expand}
            >
              {activity}
            </ActivityDisclosure>
          </div>
        </div>
      )}
      {["complete", "recovered", "coordination"].includes(scenario) && (
        <div className="lab-person">
          <Avatar fallback="Rivet" alt="Rivet" shape="squircle" />
          <div>
            <p className="text-label-sm">Rivet</p>
            <p className="text-body-sm">
              The retry path now preserves the selected agent. Both checks
              passed.
            </p>
          </div>
        </div>
      )}
      <label className="lab-composer text-caption text-subtle">
        Try a draft · stays in this playground
        <textarea
          aria-label="Sample reply"
          placeholder="Reply to the thread…"
        />
      </label>
    </div>
  );
}
function Playground() {
  useKeyboardFocusVisibility();
  const [scenario, setScenario] = useState<Scenario>("working");
  const [surface, setSurface] = useState<Surface>("Inline");
  const [dark, setDark] = useState(false),
    [narrow, setNarrow] = useState(false),
    [reset, setReset] = useState(0);
  const index = scenarios.findIndex((row) => row[0] === scenario);
  const current = scenarios[index];
  useEffect(() => {
    document.documentElement.dataset.colorMode = dark ? "dark" : "light";
  }, [dark]);
  function choose(next: Scenario) {
    setScenario(next);
    if (next.startsWith("saved") || next === "multi") setSurface("Panel");
    else if (next === "missing") setSurface("Response");
    else if (next === "coordination") setSurface("Inline");
  }
  return (
    <main className="lab" data-buzz-ui="">
      <header className="lab-header">
        <div>
          <p className="text-caption text-subtle">BUZZ / LOCAL PLAYGROUND</p>
          <h1 className="text-title">Agent activity</h1>
          <p className="text-body-sm text-subtle">
            Real components. Synthetic states. Explore at your own pace.
          </p>
        </div>
        <div className="lab-actions">
          <Button size="sm" variant="ghost" onClick={() => setNarrow(!narrow)}>
            {narrow ? "Wide view" : "Narrow view"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDark(!dark)}>
            {dark ? "Light mode" : "Dark mode"}
          </Button>
        </div>
      </header>
      <div className="lab-layout">
        <nav className="lab-nav" aria-label="Activity scenarios">
          <p className="text-caption text-subtle">
            SCENARIOS · {scenarios.length}
          </p>
          {scenarios.map(([id, label], i) => (
            <button
              type="button"
              key={id}
              aria-current={id === scenario ? "true" : undefined}
              onClick={() => choose(id)}
            >
              <span className="text-caption text-subtle">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="text-body-sm">{label}</span>
            </button>
          ))}
        </nav>
        <section className="lab-stage">
          <div className="lab-description">
            <div>
              <h2 className="text-heading">{current?.[1]}</h2>
              <p className="text-body-sm text-subtle">{current?.[2]}</p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setReset(reset + 1)}
            >
              Reset state
            </Button>
          </div>
          <div className="lab-toolbar">
            <fieldset className="lab-actions" aria-label="Activity surface">
              {surfaces.map((value) => (
                <Button
                  key={value}
                  size="sm"
                  variant="ghost"
                  aria-pressed={surface === value}
                  onClick={() => setSurface(value)}
                >
                  {value}
                </Button>
              ))}
            </fieldset>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                choose(
                  scenarios[(index + 1) % scenarios.length]?.[0] ?? "working",
                )
              }
            >
              Next scenario →
            </Button>
          </div>
          <div className="lab-canvas" data-narrow={narrow}>
            <div className="lab-canvas-title text-label-sm">
              {surface === "Inline"
                ? "# Design / Thread"
                : surface === "Profile"
                  ? "Rivet / Profile activity"
                  : surface === "Response"
                    ? "Rivet / Response activity"
                    : "Agent activity"}
            </div>
            <Experience
              key={`${scenario}-${surface}-${reset}`}
              scenario={scenario}
              surface={surface}
            />
          </div>
          <p className="lab-footnote text-caption text-subtle">
            States are frozen for inspection. Reset clears disclosures and
            sample history changes. No relay, account, real agents or persistent
            storage is used. Inline surrounding conversation is fixture chrome;
            activity and coordination disclosures are production components.
          </p>
          <div className="lab-links text-body-sm">
            <a href="./index.html">Drag-out design study ↗</a>
          </div>
        </section>
      </div>
    </main>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Playground />);

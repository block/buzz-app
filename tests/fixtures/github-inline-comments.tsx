import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { GitHubPanel } from "../../src/bundled/github";
import { gitHubCli, gitHubDiff } from "../../src/bundled/github/gh";
import { createPrComments } from "../../src/bundled/github/pr-comments";
import { createPanelMemory } from "../../src/bundled/github/panel-memory";
import { PanelWorkspace } from "../../src/features/panels/PanelWorkspace";
import { Panel } from "../../src/shared/design-system/ui/Panel";
import { Button } from "../../src/shared/design-system/ui/Button";
import { Select } from "../../src/shared/design-system/ui/Select";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import { githubCommentHost } from "./github-comment-host";
import "@fontsource-variable/inter/wght.css";
import "../../src/shared/styles/globals.css";

const fixture = githubCommentHost();
const storageKey = "buzz-github-inline-stub-comments";
try {
  fixture.state.comments.push(
    ...JSON.parse(sessionStorage.getItem(storageKey) ?? "[]"),
  );
} catch {
  /* A fresh fixture starts empty. */
}
fixture.state.comments.push({
  id: 1,
  node_id: "comment-1",
  body: "A **read-only** discussion",
  user: { login: "example-reviewer" },
  html_url: "https://github.com/example-org/sample/pull/1#discussion_r1",
  created_at: "2026-01-01T00:00:00Z",
  commit_id: fixture.state.head,
  original_commit_id: fixture.state.head,
  path: "src/example.ts",
  side: "RIGHT",
  line: 5001,
  original_line: 5001,
});
const comments = createPrComments(fixture.host);
const gh = gitHubCli(fixture.host);
const diff = gitHubDiff(fixture.host);
const url = "https://github.com/example-org/sample/pull/1";
const memory = createPanelMemory();
memory.setView(
  url,
  new URLSearchParams(location.search).has("summary") ? "summary" : "changes",
);
const modes = ["success", "refresh-failed"] as const;
const fixtureWindow = window as unknown as { inlineFixture: typeof fixture };
fixtureWindow.inlineFixture = fixture;
function Fixture() {
  useKeyboardFocusVisibility();
  const [, setTick] = useState(0);
  const [mount, setMount] = useState(0);
  const [mode, setMode] = useState<(typeof modes)[number]>("success");
  useEffect(() => {
    fixture.state.onCall = () =>
      queueMicrotask(() => {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify(fixture.state.comments),
        );
        setTick((previous) => previous + 1);
      });
    return () => {
      fixture.state.onCall = () => {};
    };
  }, []);
  return (
    <main
      style={{
        height: "100dvh",
        display: "flex",
        flexDirection: "column",
        maxWidth: "1100px",
        margin: "auto",
      }}
    >
      <div
        style={{
          padding: "12px",
          display: "flex",
          flexWrap: "wrap",
          gap: "8px",
          alignItems: "center",
          maxHeight: "25dvh",
          overflowY: "auto",
          flexShrink: 0,
        }}
      >
        <strong>STUB MODE — no GitHub requests</strong>
        <Select
          label="Stub scenario"
          value={mode}
          groups={[
            {
              label: "GitHub response",
              options: modes.map((value) => ({ value, label: value })),
            },
          ]}
          onValueChange={(value) => {
            const next = modes.find((mode) => mode === value) ?? "success";
            fixture.state.mode = next;
            setMode(next);
          }}
        />
        <Button
          size="sm"
          onClick={() => {
            fixture.state.head = "c".repeat(40);
            setTick((previous) => previous + 1);
          }}
        >
          Advance head
        </Button>
        <Button
          size="sm"
          onClick={() => {
            fixture.state.base = "d".repeat(40);
            setTick((previous) => previous + 1);
          }}
        >
          Advance base
        </Button>
        <Button size="sm" onClick={() => setMount((previous) => previous + 1)}>
          Remount panel
        </Button>
        <Button
          size="sm"
          onClick={() => {
            fixture.state.patch = "Malformed patch fixture";
          }}
        >
          Show raw patch
        </Button>
        <Button
          size="sm"
          onClick={() => {
            fixture.state.snapshotFailed = !fixture.state.snapshotFailed;
          }}
        >
          Toggle snapshot failure
        </Button>
        <Button
          size="sm"
          onClick={() => {
            sessionStorage.removeItem(storageKey);
            location.reload();
          }}
        >
          Reset fixture
        </Button>
      </div>
      <Panel style={{ flex: 1, minHeight: 0 }}>
        <PanelWorkspace
          value="github"
          select={() => {}}
          items={[
            {
              id: "github",
              label: "GitHub",
              content: (
                <GitHubPanel
                  key={mount}
                  target={url}
                  close={() => {}}
                  gh={gh}
                  diff={diff}
                  comments={comments}
                  memory={memory}
                />
              ),
            },
          ]}
        />
      </Panel>
      <details>
        <summary>
          Stub endpoint readback ({fixture.state.comments.length} stored
          comments)
        </summary>
        <pre data-testid="stub-readback">
          {JSON.stringify(
            {
              posts: fixture.state.calls.filter(
                (call) => call.args[0] === "POST",
              ).length,
              comments: fixture.state.comments,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<Fixture />);

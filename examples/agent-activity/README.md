# Agent activity visual preview

Interactive design study for compact, progressively disclosed agent Activity.
Uses real Buzz shared components with explicitly synthetic content. No app startup,
relay, dotenv, private profiles, native IPC, agent execution, or persistence.

From the repository root:

```sh
bin/pnpm exec vite --config examples/agent-activity/vite.config.ts
```

Open http://127.0.0.1:1451/examples/agent-activity/index.html.

- Click the agent's action to expand/collapse inline; click a step for details.
- Drag the activity heading toward the right edge to open the side panel. Neither
  the compact row nor expanded activity has an open-outside icon or text action.
  The production keyboard/non-drag alternative is still to be designed; this mock
  is not an accessible drag-only interaction to ship.
- Opening the panel collapses inline detail, keeping the channel and thread.
- Top controls preview Working, Expanded, Completed and Unknown states; the moon
  toggles existing dark tokens. These controls are not proposed product chrome.
- Completed leaves View activity above the reply. Data and wording are illustrative,
  not claims that live telemetry already supplies these exact descriptions.

At intermediate widths the three-pane workspace scrolls horizontally rather than
removing a conversation. At narrow widths the channel context is hidden and the
optional activity panel stacks below the thread. These are prototype responsive
choices to review, not changes to production navigation.

## Sample week (real Activity renderer)

`week.html` shows 18–24 September: one observed synthetic agent in `#research`,
fourteen ended runs and 124 events. It uses the real profile-mode `ActivityDetails`
with a static fixture snapshot. The September 21 run includes a teammate's request,
a structured send to Review agent, that peer's reported incoming reply, and the
selected agent's response. Peer-internal activity is not merged into the view.
Expand Message details for reported author/event IDs and raw evidence, or groups
and tools for input/output. The failed-check/retry example and appearance toggle
remain available. This demonstrates supported single-event prompt framing and
structured message-send tools; it does not establish all producer-format parity
or message-body lookup for shell sends. Each run includes its
sample date in the text because the production turn heading currently shows time
only. No date-navigation or historical-query UI is invented for the preview.

With the normal preview server, open
http://127.0.0.1:1451/examples/agent-activity/week.html. If that port belongs to a
different worktree, leave it running and use a separate port:

```sh
bin/pnpm exec vite --config examples/agent-activity/vite.config.ts --port 1452 --strictPort
```

Then open http://127.0.0.1:1452/examples/agent-activity/week.html.
This is **synthetic data, not a working saved-history feature**. No relay, native
API, account, archive, real files, or persistent storage is accessed. All runs are
ended; the fixture does not make old activity appear currently working.

## Focused checks

```sh
bin/pnpm exec tsc -p examples/agent-activity/tsconfig.json
bin/pnpm exec biome check --error-on-warnings examples/agent-activity
bin/pnpm exec vite build --config examples/agent-activity/vite.config.ts
# With the offline preview server running and the repo browser engines installed:
bin/node examples/agent-activity/check.mjs
```

The opt-in check uses Chromium and WebKit for native drag/drop, inline disclosures,
keyboard activation, panel focus/return, completed-entry geometry, unknown state,
and 1440/1024/390px layouts. It waits for actual transitions before screenshots.
Screenshots are written under `/tmp/buzz-activity-*`. This check is outside the
product E2E suite: it proves prototype interaction/layout only. Product integration,
real activity mapping, narrow-screen interaction design, and native/live acceptance
remain separate work. No shared design-system files are modified.

## Real readable-stream slice

Open http://127.0.0.1:1451/examples/agent-activity/stream.html on the same offline
server. Unlike the original mock, this page renders the actual ActivityDetails
panel and current session activity service. Only its events/profiles are synthetic.
Two turns demonstrate prompts, commentary, tools and output. Use Interrupt feed,
Clear and Reset sample to inspect unknown/empty/recovery states. No real services
or agent processes are used. This page is a dev fixture, not a shipped route.

The main app's existing Activity panel now uses that renderer. Moving the entry
into messages and preserving a thread beside the detached panel are still pending;
this sample does not claim those integrations are complete.

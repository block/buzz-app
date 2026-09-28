import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ActivityDetails } from "../../src/bundled/agent-activity/ActivityPanel";
import type { RelaySession } from "../../src/features/relay/session";
import { Avatar } from "../../src/shared/design-system/ui/Avatar";
import { Button } from "../../src/shared/design-system/ui/Button";
import { Panel } from "../../src/shared/design-system/ui/Panel";
import { PanelHeader } from "../../src/shared/design-system/ui/PanelHeader";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import "../../src/shared/styles/globals.css";

// Offline, static sample only. Never activates a relay, agent, or archive.
// Keep the real component's live-only disclosure: this is not persisted history.
const agent = "a".repeat(64);
const human = "b".repeat(64),
  peer = "c".repeat(64);
const channelId = "sample-research";
type Snapshot = ReturnType<RelaySession["agentActivity"]["snapshot"]>;
const records: Snapshot["records"][number][] = [];
const turns: Snapshot["turns"][number][] = [];
const days = [
  [
    "2026-09-18",
    "Gather research",
    "SOURCES.md",
    "I’ll gather the source material and note gaps before drafting.",
    "Collected eight sources and recorded two questions for follow-up.",
  ],
  [
    "2026-09-19",
    "Draft the report",
    "LIONS.md",
    "I’ll turn the research into a readable report, keeping facts linked to their sources.",
    "The first draft is ready for review, with source references beside the key claims.",
  ],
  [
    "2026-09-20",
    "Check citations",
    "SOURCES.md",
    "I’m checking citations and marking anything I cannot verify.",
    "Corrected two references. One source is still unavailable and is called out in the notes.",
  ],
  [
    "2026-09-21",
    "Translate to Spanish",
    "LIONS_ES.md",
    "I’ll translate the report, then check terminology and accents.",
    "Spanish translation drafted. Scientific names remain unchanged.",
  ],
  [
    "2026-09-22",
    "Incorporate feedback",
    "LIONS.md",
    "I’m comparing the review notes with the draft and making focused edits.",
    "Incorporated the requested changes and shortened the introduction.",
  ],
  [
    "2026-09-23",
    "Validate both versions",
    "CHECKS.md",
    "I’ll check word counts, references, and consistency between the two versions.",
    "The checks are complete. The remaining caveat is documented beside the affected source.",
  ],
  [
    "2026-09-24",
    "Prepare handoff",
    "HANDOFF.md",
    "I’m collecting the final files and a concise summary for the handoff.",
    "Prepared the handoff with links to the English report, translation, sources, and review notes.",
  ],
] as const;
let serial = 0;
for (const [date, title, file, thought, result] of days) {
  for (const afternoon of [false, true]) {
    const base = new Date(
      `${date}T${afternoon ? "14:30" : "09:15"}:00`,
    ).getTime();
    const turnId = `sample-${date}-${afternoon ? "review" : "work"}`;
    let sequence = 0;
    const emit = (kind: string, payload: unknown) => {
      const timestamp = base + sequence++ * 15_000;
      records.push({
        id: (++serial).toString(16).padStart(64, "0"),
        agent,
        createdAt: Math.floor(timestamp / 1000),
        receivedAt: timestamp,
        kind,
        channelIds: [channelId],
        plaintext: JSON.stringify({
          kind,
          seq: sequence,
          timestamp: new Date(timestamp).toISOString(),
          channelId,
          turnId,
          sessionId: "sample-session",
          payload,
        }),
      });
    };
    const update = (value: object) =>
      emit("acp_read", {
        method: "session/update",
        params: { sessionId: "sample-session", update: value },
      });
    emit("turn_started", {
      triggeringEventIds: [(serial + 1000).toString(16).padStart(64, "0")],
    });
    const incoming = (
      from: string,
      name: string,
      content: string,
      audience = "everyone",
    ) =>
      emit("acp_write", {
        method: "session/prompt",
        params: {
          prompt: [
            {
              type: "text",
              text: `<context>\nSample channel context only.\n</context>\n<buzz-event type="@mention">\nEvent ID: ${(serial + 1000).toString(16).padStart(64, "0")}\nChannel: Research (#${channelId})\nKind: 9\nFrom: ${name} (hex: ${from})\nTime: ${new Date(base).toISOString()}\nContent: ${content}\nTags: [["h","${channelId}"],["audience","${audience}"]]\n</buzz-event>`,
            },
          ],
        },
      });
    incoming(
      human,
      "Sample teammate",
      afternoon
        ? `Review the latest changes for ${title.toLowerCase()}.`
        : title,
    );
    update({
      sessionUpdate: "agent_thought_chunk",
      content: {
        type: "text",
        text: `${date} · ${afternoon ? "Review" : title}\n${afternoon ? "I’m reviewing the latest changes and checking the result before responding." : thought}`,
      },
    });
    update({
      sessionUpdate: "tool_call",
      toolCallId: `${turnId}-read`,
      title: "buzz-dev-mcp__read_file",
      status: "completed",
      rawInput: { path: `OUTBOX/${file}` },
      rawOutput: `# ${title}\n\nSample contents of ${file}.\n\nThis fixture contains no real workspace files or agent output.`,
    });
    if (!afternoon)
      update({
        sessionUpdate: "tool_call",
        toolCallId: `${turnId}-edit`,
        title: "buzz-dev-mcp__str_replace",
        status: "completed",
        rawInput: {
          path: `OUTBOX/${file}`,
          old_str: "Draft text awaiting review.",
          new_str: "Revised sample text with checked references.",
        },
        rawOutput: "One matching passage replaced.",
      });
    if (date === "2026-09-21" && !afternoon) {
      update({
        sessionUpdate: "tool_call",
        toolCallId: `${turnId}-ask-peer`,
        title: "send_message",
        status: "completed",
        rawInput: {
          channel_id: channelId,
          content:
            "@Review agent please check the Spanish terminology and flag any translation mistakes.",
        },
        rawOutput: {
          accepted: true,
          event_id: (serial + 2000).toString(16).padStart(64, "0"),
          audience: "agents",
        },
      });
      incoming(
        peer,
        "Review agent",
        "@Sample agent I checked the terminology. Keep ‘león’ accented and retain Panthera leo unchanged. The rest reads naturally.",
        "agents",
      );
      update({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "I’ve incorporated Review agent’s corrections. I’ll run one last check before sharing the translation.",
        },
      });
    }
    const failure = date === "2026-09-20" && !afternoon;
    const shell = (suffix: string, failed: boolean) =>
      update({
        sessionUpdate: "tool_call",
        toolCallId: `${turnId}-${suffix}`,
        title: "buzz-dev-mcp__shell",
        status: failed ? "failed" : "completed",
        rawInput: {
          command: failure
            ? "node scripts/check-links.mjs OUTBOX/SOURCES.md"
            : `wc -w OUTBOX/${file}`,
        },
        rawOutput: {
          stdout: failed
            ? ""
            : failure
              ? "7 checked; 1 unavailable source explicitly noted."
              : `512 OUTBOX/${file}`,
          stderr: failed
            ? "One source could not be reached. No changes were published."
            : "",
          exit_code: failed ? 1 : 0,
          timed_out: false,
          stdout_truncated: false,
          stderr_truncated: false,
        },
      });
    shell("check", failure);
    if (failure) {
      update({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "One link is unavailable. I’ll retry the check and preserve the caveat if it still cannot be verified.",
        },
      });
      shell("retry", false);
    }
    update({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: afternoon ? `Review finished. ${result}` : result,
      },
    });
    update({
      sessionUpdate: "tool_call",
      toolCallId: `${turnId}-send-result`,
      title: "send_message",
      status: "completed",
      rawInput: {
        channel_id: channelId,
        content: `@Sample teammate ${afternoon ? "Review finished. " : ""}${result}`,
      },
      rawOutput: {
        accepted: true,
        event_id: (serial + 3000).toString(16).padStart(64, "0"),
        audience: "everyone",
      },
    });
    emit("turn_completed", {});
    turns.push({
      agent,
      channelId,
      turnId,
      timestamp: base + sequence * 15_000,
      state: "ended",
    });
  }
}
const snapshot: Snapshot = Object.freeze({
  status: "listening",
  records: Object.freeze(records),
  turns: Object.freeze(turns),
  typing: [],
  trimmed: 0,
});
const profiles = new Map([
  [agent, { name: "Sample agent", isAgent: true }],
  [human, { name: "Sample teammate", isAgent: false }],
  [peer, { name: "Review agent", isAgent: true }],
]);
const channels = {
  status: "ready",
  channels: [{ id: channelId, name: "research" }],
};
const noopSubscribe = () => () => {};
const session = {
  agentActivity: { snapshot: () => snapshot, subscribe: noopSubscribe },
  profiles: { snapshot: () => profiles, subscribe: noopSubscribe },
  channels: { list: () => channels, subscribeList: noopSubscribe },
  live: { retry() {} },
} as unknown as RelaySession;

function WeekPreview() {
  useKeyboardFocusVisibility();
  const [dark, setDark] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.colorMode = dark ? "dark" : "light";
  }, [dark]);
  return (
    <main className="min-h-screen bg-surface-panel p-6 text-standard">
      <header className="mx-auto mb-6 flex max-w-3xl flex-col gap-3">
        <h1 className="text-heading">Sample week of agent activity</h1>
        <p className="text-body-sm">
          18–24 September · #research · 14 ended runs · {records.length} sample
          events
        </p>
        <p className="text-body-sm text-subtle">
          Synthetic data in the real Activity renderer. No live account, relay,
          files, or saved-history implementation. Expand a tool group, then a
          step, to inspect its input and output.
        </p>
        <div>
          <Button size="sm" variant="ghost" onClick={() => setDark(!dark)}>
            {dark ? "Light appearance" : "Dark appearance"}
          </Button>
        </div>
      </header>
      <div className="mx-auto" style={{ maxWidth: "32rem" }}>
        <Panel>
          <PanelHeader title="Activity sample" />
          <div className="flex flex-col gap-6 p-5">
            <div className="flex items-center gap-4">
              <Avatar
                alt=""
                fallback="Sample agent"
                shape="squircle"
                size="large"
              />
              <h2 className="text-heading">Sample agent</h2>
            </div>
            <ActivityDetails
              session={session}
              selection={{ agent, channelId, view: "profile" }}
            />
          </div>
        </Panel>
      </div>
    </main>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<WeekPreview />);

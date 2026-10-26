import type { GithubPolicy } from "../../src/features/agents/github-policy";
// The production page and shared controls, with only the host data boundary replaced.
import { createRoot } from "react-dom/client";
import type { Context } from "../../src/plugins/author";
import { createPage } from "../../src/bundled/agents/attention/Page";
import "../../src/shared/styles/globals.css";

const channel = "11111111-1111-4111-8111-111111111111";
const listeners = new Set<() => void>();
const value = {
  type: "event",
  name: "Release discussion",
  enabled: true,
  interest_id: "release",
  since: 0,
  kinds: [9],
  channels: [channel],
  channel,
};
let snapshot = {
  status: "ready",
  running: [
    {
      pubkey: "a".repeat(64),
      name: "Ada",
      attentionEnabled: true,
      timers: {},
      attention: {
        "interest/release": {
          slug: "interest/release",
          modifiedAt: 1,
          value: {
            type: "interest",
            instructions:
              "# Release planning\nReport blockers and keep the release moving.",
          },
        },
        "watch/discussion": { slug: "watch/discussion", modifiedAt: 1, value },
      },
    },
  ],
};
const channels = {
  channels: [{ id: channel, name: "Release planning", channelType: "stream" }],
};
const connection = {
  status: "ready",
  scope: "https://example.com:viewer",
  session: {
    media: () => "",
    channels: {
      ensureList() {},
      subscribeList: () => () => {},
      list: () => channels,
    },
  },
};
let policy: GithubPolicy = {
  version: 1,
  trustedOrganizations: [],
  trustedAuthors: [],
  ignoredAuthors: [],
};
const policyHost = {
  spawn: async (
    _id: string,
    options: { args: string[]; onStdout(data: string): void },
  ) => {
    if (options.args[0] === "write") policy = JSON.parse(options.args[1] ?? "");
    const configured = Boolean(
      policy.trustedOrganizations.length || policy.trustedAuthors.length,
    );
    options.onStdout(
      JSON.stringify({
        path: "/home/example-user-with-a-long-name/.buzz/preferences/github-pr.json",
        policy,
        configured,
        error: null,
        warning: configured
          ? null
          : "No GitHub author allowlist configured. CI and PR-state monitoring will continue, but comments and reviews won't be delivered. Configure trusted organizations and/or individual commenters to enable them.",
      }),
    );
    return { exited: Promise.resolve(0) };
  },
};
const Page = createPage({
  host: policyHost,
  agents: {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    save: async (
      _key: string,
      patch: {
        attentionEnabled?: boolean;
        attention?: Record<string, unknown>;
      },
    ) => {
      const agent = snapshot.running[0];
      if (!agent) throw new Error("No fixture agent");
      const attention: Record<string, unknown> = { ...agent.attention };
      for (const [slug, value] of Object.entries(patch.attention ?? {})) {
        if (value === null) delete attention[slug];
        else attention[slug] = { slug, value, modifiedAt: 2 };
      }
      snapshot = {
        ...snapshot,
        running: [
          {
            ...agent,
            attentionEnabled: patch.attentionEnabled ?? agent.attentionEnabled,
            attention: attention as typeof agent.attention,
          },
        ],
      };
      for (const listener of listeners) listener();
    },
  },
  relay: { snapshot: () => connection, subscribe: () => () => {} },
  navigation: { open: async () => {} },
} as unknown as Context);
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Page />);

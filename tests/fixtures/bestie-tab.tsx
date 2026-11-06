// The production Bestie tabs in the Agents side panel's layout, with only the
// host data boundary replaced. `?former` shows the Former Bestie tab, and
// `?edited` a memory section whose closing marker was edited by hand.
import "../../src/shared/styles/globals.css";
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import styles from "../../src/bundled/agents/AgentsPage.module.css";
import { bestieTab, formerBestieTab } from "../../src/bundled/bestie/BestieTab";
import {
  checkinHourly,
  inbox,
  memory,
  withFeature,
} from "../../src/bundled/bestie/features";
import type { Agent, AgentChange } from "../../src/features/agents/service";
import type { MemberChange } from "../../src/features/channel-members/administration-protocol";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import type { RelayData } from "../../src/features/relay/service";

const OWNER = "f".repeat(64);
const ADA = "a".repeat(64);
const BEA = "b".repeat(64);
const query = new URLSearchParams(location.search);
const former = query.has("former");
const edited = query.has("edited");
const channel = (name: string, members: string[]) => ({
  id: `id-${name}`,
  name,
  channelType: "stream",
  private: true,
  members,
});
let list = {
  status: "ready" as const,
  channels: [
    channel("design-reviews-and-weekly-planning-notes", [OWNER, ADA]),
    channel("family", [OWNER, ADA]),
    channel("leadership-offsite", [OWNER]),
    channel("hiring", [OWNER]),
  ],
};
const listListeners = new Set<() => void>();
// These edits stay in fixture memory. No account, relay, or native host is used.
function membership(id: string, pubkey: string, join: boolean) {
  list = {
    ...list,
    channels: list.channels.map((item) =>
      item.id !== id
        ? item
        : {
            ...item,
            members: join
              ? [...new Set([...item.members, pubkey])]
              : item.members.filter((key) => key !== pubkey),
          },
    ),
  };
  for (const listener of listListeners) listener();
}
const operations = new Map<
  string,
  { change: MemberChange; status: "confirmed" }
>();
const choice = (pubkey: string, name: string) => ({
  pubkey,
  name,
  managed: true,
});
const choices = {
  status: "ready",
  complete: true,
  pending: false,
  identities: [choice(ADA, "Ada"), choice(BEA, "Bea")],
  selectable: [choice(ADA, "Ada"), choice(BEA, "Bea")],
  archives: { status: "unavailable", archived: [] },
};
const connection = {
  status: "ready",
  scope: `https://relay.example:${OWNER}`,
  session: {
    viewer: OWNER,
    outbox: { supports: () => true },
    directMessages: { open: async () => "dm" },
    channels: {
      list: () => list,
      subscribeList: (listener: () => void) => {
        listListeners.add(listener);
        return () => {
          listListeners.delete(listener);
        };
      },
      ensureList: () => {},
    },
    memberAdditions: {
      add: async (id: string, pubkey: string) => membership(id, pubkey, true),
    },
    memberAdministration: {
      refresh: async () => {},
      run: async (id: string, change: MemberChange) => {
        membership(id, change.pubkey, false);
        operations.set(id, { change, status: "confirmed" });
      },
      snapshot: (id: string) => ({
        status: "ready",
        authority: {
          roles: Object.fromEntries(
            (list.channels.find((item) => item.id === id)?.members ?? []).map(
              (key) => [key, "guest"],
            ),
          ),
        },
        operation: operations.get(id),
      }),
    },
    mainAgent: {
      read: async () => (former ? BEA : ADA),
      write: async () => {},
    },
    agentChoices: {
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
    },
  },
};
const relay = {
  snapshot: () => connection,
  subscribe: () => () => {},
} as unknown as RelayData;
const agentListeners = new Set<() => void>();
const agents = {
  save: async (_key: string, change: AgentChange) => {
    agent = {
      ...agent,
      ...change,
      attention: { ...agent.attention, ...change.attention },
    } as Agent;
    for (const listener of agentListeners) listener();
  },
  types: () => [{ key: "claude-code", adopt: () => ({}) }],
  // Both are on this device, so neither is asked about as remote.
  find: (pubkey: string) =>
    [ADA, BEA].includes(pubkey) ? { pubkey, place: "here" } : undefined,
};
let agent = {
  key: ADA,
  pubkey: ADA,
  name: "Ada",
  type: "claude-code",
  owner: OWNER,
  relay: "wss://relay.example",
  place: "here",
  attentionEnabled: true,
  attention: {
    "interest/bestie-hourly-check-in": { value: { type: "interest" } },
    "watch/bestie-hourly-check-in": { value: { type: "timer" } },
  },
  config: {
    instructions: withFeature(
      withFeature(withFeature("Be brief.", memory, true), inbox, true),
      checkinHourly,
      true,
    ).replace(
      "<!-- /buzz:bestie/memory -->",
      edited ? "<!-- /buzz:bestie/memory--> Also answer in French." : "$&",
    ),
  },
} as unknown as Agent;
const tab = (former ? formerBestieTab : bestieTab)(relay, agents);
const Tab = tab.component;
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
function Fixture() {
  useKeyboardFocusVisibility();
  const current = useSyncExternalStore(
    (listener) => {
      agentListeners.add(listener);
      return () => {
        agentListeners.delete(listener);
      };
    },
    () => agent,
  );
  return (
    <div
      style={{ display: "flex", justifyContent: "flex-end", height: "100%" }}
    >
      <aside
        className={styles.side}
        aria-label="Agent panel"
        style={{
          width: "var(--secondary-panel-width, 28rem)",
          overflow: "auto",
        }}
      >
        <div className={styles.detailsScroll}>
          <section aria-label="Ada settings">
            <div className="grid gap-6 pt-4">
              <p className="text-caption text-secondary">
                Local preview · synthetic settings · no account changes
              </p>
              <Tab agent={current} />
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}
createRoot(root).render(<Fixture />);

// Real timeline and Virtua, with local data and no broker or live credentials.
import { createRoot } from "react-dom/client";
import { useState, useMemo, useSyncExternalStore } from "react";
import { createChannelPresentation } from "../../src/features/messages/channel-presentation";
import { ChannelTimeline } from "../../src/features/messages/ChannelTimeline";
import { createRelaySession } from "../../src/features/relay/session";
import { keypair } from "../../src/features/relay/testing";
import type {
  ChannelMessage,
  ChannelWindow,
} from "../../src/features/relay/contracts";
import { Button } from "../../src/shared/design-system/ui/Button";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import styles from "../../src/features/messages/Messages.module.css";
import "../../src/shared/styles/globals.css";

const owner = createRelaySession({
  viewer: keypair().pubkey,
  relayAuthor: keypair().pubkey,
  media: () => undefined,
  query: async () => [],
});
const agent = keypair().pubkey;
const update = (index: number): ChannelMessage => ({
  id: `activity-${index}`,
  channelId: "solo",
  authorId: agent,
  audience: "agents",
  createdAt: 1792152000 + index,
  content: `Activity update ${index}. Checked the conversation layout and kept the history available.\n\nThe expanded details explain what changed and why. They stay readable while the surrounding space opens.\n\nLinks, attachments and message actions continue to use the normal message renderer.`,
  mentions: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
  participants: [],
});
let current: ChannelWindow = Object.freeze({
  channelId: "solo",
  rows: Object.freeze(Array.from({ length: 16 }, (_, index) => update(index))),
  status: "ready",
  hasMore: false,
  loadingOlder: false,
  freshness: "verified",
  error: undefined,
});
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => current;
const publish = (rows: readonly ChannelMessage[]) => {
  current = Object.freeze({ ...current, rows: Object.freeze([...rows]) });
  for (const listener of [...listeners]) listener();
};
const queries = {
  ...owner.session,
  channels: {
    ...owner.session.channels,
    window: (id: string) =>
      id === "solo" ? current : owner.session.channels.window(id),
    subscribeWindow: (id: string, listener: () => void) =>
      id === "solo"
        ? subscribe(listener)
        : owner.session.channels.subscribeWindow(id, listener),
  },
};
const keyed =
  new URLSearchParams(location.search).get("presentation") === "keyed";
function Fixture() {
  useKeyboardFocusVisibility();
  const window = useSyncExternalStore(subscribe, snapshot, snapshot);
  const rows = window.rows;
  const presentation = useMemo(
    () =>
      keyed
        ? createChannelPresentation(queries, "solo", {
            chat: true,
            viewer: undefined,
          })
        : undefined,
    [],
  );
  const [inlineTarget, setTarget] = useState<{
    messageId: string;
    signal: AbortSignal;
  }>();
  return (
    <main
      style={{
        height: "100dvh",
        display: "flex",
        flexDirection: "column",
        padding: 24,
        gap: 8,
      }}
    >
      <nav style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button
          onClick={() =>
            publish([
              ...rows,
              update(Number(rows.at(-1)?.id.split("-").at(-1) ?? -1) + 1),
            ])
          }
        >
          Append update
        </Button>
        <Button
          onClick={() =>
            setTarget({
              messageId: "activity-0",
              signal: new AbortController().signal,
            })
          }
        >
          Visit first update
        </Button>
        <Button onClick={() => publish([update(-1), ...rows])}>
          Prepend history
        </Button>
      </nav>
      <div className={styles.thread} style={{ flex: 1 }}>
        <ChannelTimeline
          transient
          channelId="solo"
          scope="activity-groups-fixture"
          queries={queries}
          chatPresentation
          inlineTarget={inlineTarget}
          {...(presentation ? { presentation } : { window })}
          onOpenLink={() => false}
        />
      </div>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);

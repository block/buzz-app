import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { PluginModule } from "../../plugins/api";
import {
  useChannelList,
  useChannelWindow,
  useRelayConnection,
} from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import { ChannelTimeline } from "../../features/messages/ChannelTimeline";
import { MessageComposer } from "../../features/messages/MessageComposer";
import { ThreadPanel } from "../../features/messages/ThreadPanel";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";

import type { AgentControl } from "../../features/agents/control";
import { BestieSetup } from "./BestieSetup";
import { BestieBaseline } from "./BestieBaseline";
import { BestieMemories } from "./BestieMemories";

export const inject = ["panels", "relay", "conversation", "agentControl"];

// There is no product flow yet for discovering "my companion's channel" —
// The owner chooses an existing channel in the connected community and
// pastes its ID here; kept in localStorage, not synced.
const STORAGE_KEY = "buzz.bestie.channelId";

export const apply: PluginModule["apply"] = (ctx) => {
  ctx.panels.register({
    id: "companion",
    title: "Bestie",
    matches: () => false,
    launcher: { icon: "/bestie.png", target: "" },
    component: () => (
      <Bestie
        relay={ctx.relay}
        extensions={ctx.conversation}
        control={ctx.agentControl}
      />
    ),
  });
};

function Bestie({
  relay,
  extensions,
  control,
}: {
  control?: AgentControl;
  relay: RelayData;
  extensions: ConversationExtensions;
}) {
  const connection = useRelayConnection(relay);
  const [channelId, setChannelId] = useState(
    () => localStorage.getItem(STORAGE_KEY) ?? "",
  );
  const connect = useCallback((id: string) => {
    const trimmed = id.trim();
    localStorage.setItem(STORAGE_KEY, trimmed);
    setChannelId(trimmed);
  }, []);

  if (connection.status !== "ready") {
    return (
      <Empty>
        {connection.status === "connecting"
          ? "Connecting to your community…"
          : "Connect to a community to chat with Bestie."}
      </Empty>
    );
  }
  const setup = (
    <BestieSetup
      control={control}
      destination={connection.scope?.slice(0, -65) ?? ""}
      owner={connection.session.viewer ?? ""}
    />
  );
  if (!channelId)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex justify-end p-2">{setup}</div>
        <ChannelPicker onConnect={connect} />
      </div>
    );
  return (
    <BestieChannel
      key={`${connection.scope}:${channelId}`}
      session={connection.session}
      extensions={extensions}
      scope={connection.scope ?? ""}
      channelId={channelId}
      setup={setup}
      onChangeChannel={() => connect("")}
    />
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <img src="/bestie.png" alt="" className="size-20 object-contain" />
      <h2 className="text-heading">Meet your Bestie</h2>
      <p className="max-w-xs text-body-sm text-muted">{children}</p>
    </div>
  );
}

function ChannelPicker({ onConnect }: { onConnect: (id: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="flex min-h-full flex-col items-center justify-center gap-4 p-6 text-center"
      onSubmit={(event) => {
        event.preventDefault();
        onConnect(value);
      }}
    >
      <img src="/bestie.png" alt="" className="size-20 object-contain" />
      <h2 className="text-heading">Meet your Bestie</h2>
      <p className="max-w-xs text-body-sm text-muted">
        Paste the Channel ID from an existing conversation in this community.
        You can find it in the channel settings. Your account and Bestie must
        both be members.
      </p>
      <div className="w-full max-w-xs">
        <Field label="Channel id">
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
          />
        </Field>
      </div>
      <Button type="submit" disabled={!value.trim()}>
        Connect
      </Button>
    </form>
  );
}

function BestieChannel({
  session,
  extensions,
  scope,
  channelId,
  onChangeChannel,
  setup,
}: {
  setup: ReactNode;
  session: RelaySession;
  extensions: ConversationExtensions;
  scope: string;
  channelId: string;
  onChangeChannel: () => void;
}) {
  const list = useChannelList(session.channels);
  const channel = list.channels.find((item) => item.id === channelId);
  const window = useChannelWindow(session.channels, channelId);
  const [thread, setThread] = useState<{
    id: string;
    replyRequest: number | undefined;
  }>();
  // The first window request can precede discovery of this channel's roster.
  // Retry that idempotent demand when the authorized channel becomes known.
  const knownChannelId = channel?.id;
  useEffect(() => {
    if (knownChannelId) session.channels.ensure(knownChannelId);
  }, [session, knownChannelId]);
  if (!channel) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <img src="/bestie.png" alt="" className="size-20 object-contain" />
        <h2 className="text-heading">Meet your Bestie</h2>
        <p className="max-w-xs text-body-sm text-muted">
          Can’t find that channel yet. Check the selected community and Channel
          ID, and make sure this account is a member. A channel from another
          relay or account won’t connect automatically.
        </p>
        <Button size="compact" onClick={onChangeChannel}>
          Try a different channel
        </Button>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      <div className="flex flex-wrap items-center justify-end">
        {setup}
        <BestieBaseline
          session={session}
          channelId={channelId}
          members={channel.members ?? []}
        />
        <BestieMemories
          session={session}
          channelId={channelId}
          members={channel.members ?? []}
        />
        <Button size="compact" variant="ghost" onClick={onChangeChannel}>
          Change channel
        </Button>
      </div>
      {thread ? (
        <div className="flex min-h-0 flex-1 flex-col [&>aside]:flex-1">
          <ThreadPanel
            extensions={extensions}
            session={session}
            scope={scope}
            channelId={channelId}
            channelName={channel.name}
            sessionConversation={channel.channelType === "session"}
            messageId={thread.id}
            replyRequest={thread.replyRequest}
            close={() => setThread(undefined)}
            onOpenLink={() => false}
          />
        </div>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col">
            {window.status !== "ready" && !window.rows.length ? (
              <p className="p-4 text-body-sm text-muted" role="status">
                Loading messages…
              </p>
            ) : (
              <ChannelTimeline
                extensions={extensions}
                queries={session}
                viewer={session.viewer}
                scope={scope}
                channelId={channelId}
                window={window}
                onOpenThread={(_messageId, rootId, intent) =>
                  setThread({
                    id: rootId,
                    replyRequest: intent === "reply" ? 1 : undefined,
                  })
                }
                onOpenLink={() => false}
              />
            )}
          </div>
          <MessageComposer
            extensions={extensions}
            session={session}
            scope={scope}
            channelId={channelId}
            channelName={channel.name}
            disabled={window.status !== "ready"}
            onOpenLink={() => false}
          />
        </>
      )}
    </div>
  );
}

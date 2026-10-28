import "../../src/shared/styles/globals.css";
import { StrictMode, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Context } from "@deepseek-ai/cordis";
import { createPluginManager } from "../../src/plugins/manager";
import { ConversationService } from "../../src/features/conversation/service";
import type {
  ComposerCompletionProps,
  CompletionResult,
} from "../../src/features/conversation/contracts";
import type { KeyboardEvent } from "react";
import { createRelaySession } from "../../src/features/relay/session";
import {
  keypair,
  metadata,
  roster,
  signed,
} from "../../src/features/relay/testing";
import { matchesEvent } from "../../src/features/relay/projection";
const viewer = keypair(),
  relay = keypair();
const publications: unknown[] = [];
let retries = 0;
const requests: {
  query: string;
  publish: ComposerCompletionProps["publish"];
}[] = [];
const disposers = new Map<number, () => void>();
const keyPublications: unknown[] = [];
let keyPublication:
  | { index: number; key: string; result: CompletionResult | "withdraw" }
  | undefined;
function publish(index: number, result: CompletionResult) {
  const withdraw = requests[index]?.publish(result);
  if (withdraw) disposers.set(index, withdraw);
  return !!withdraw;
}
function publishOnKey(event: KeyboardEvent) {
  const pending = keyPublication;
  if (!pending || event.key !== pending.key) return;
  keyPublication = undefined;
  const options = () =>
    [...document.querySelectorAll('[role="option"]')].map(
      (el) => el.textContent,
    );
  const before = options();
  let accepted = false;
  if (pending.result === "withdraw") {
    const withdraw = disposers.get(pending.index);
    if (withdraw) {
      withdraw();
      accepted = true;
    }
  } else accepted = publish(pending.index, pending.result);
  // The external provider publishes during React's native-key capture. This
  // does not dispatch, cancel, slow, or replace the originating trusted input.
  keyPublications.push({
    key: event.key,
    trusted: event.nativeEvent.isTrusted,
    query: requests[pending.index]?.query,
    before,
    after: options(),
    accepted,
  });
}
function Provider({ query, publish }: ComposerCompletionProps) {
  useLayoutEffect(() => {
    requests.push({ query: query.query, publish });
  }, [query.query, publish]);
  return null;
}
const context = new Context();
const manager = createPluginManager(context, {
  bundled: [
    {
      manifest: {
        id: "test.completion",
        name: "Test completion",
        apiVersion: 1,
      },
      module: {
        inject: ["conversation"],
        apply(ctx) {
          ctx.conversation.registerCompletion({
            id: "delayed",
            title: "Delayed",
            match: ({ text, start }) =>
              text.startsWith("!") && start > 0
                ? { start: 0, end: start, query: text.slice(1, start) }
                : null,
            component: Provider,
            queryUpdates: "props",
          });
        },
      },
    },
  ],
});
const conversation = new ConversationService(context);
const owners = ["a", "b"].map((scope) =>
  createRelaySession(
    {
      scope,
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      async query(filters) {
        return [
          roster(relay, "c", [viewer.pubkey]),
          metadata(relay, "c", "Test"),
          roster(relay, "other", [viewer.pubkey]),
          metadata(relay, "other", "Other"),
        ].filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
      },
      writer: {
        kinds: [9],
        async sign(event) {
          return signed(viewer, event);
        },
        async publish(event) {
          publications.push(event);
        },
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  ),
);
for (const owner of owners) owner.session.channels.ensureList();
Object.assign(window, {
  completionFixture: {
    queries: () => requests.map((request) => request.query),
    publish,
    onKey(index: number, key: string, result: CompletionResult | "withdraw") {
      keyPublication = { index, key, result };
    },
    keyPublications,
    viewer: viewer.pubkey,
    change: (action: "enable" | "disable") =>
      manager.change(action, "test.completion"),
    publications,
    retries: () => retries,
    fail(index: number, withChoice = false) {
      return !!requests[index]?.publish({
        items: withChoice
          ? [{ id: "choice", label: "Choice", edit: { text: "choice" } }]
          : [],
        status: "Fixture unavailable",
        retry: () => {
          retries++;
          requests[index]?.publish({
            items: [
              {
                id: "recovered",
                label: "Recovered",
                edit: { text: "recovered" },
              },
            ],
          });
        },
      });
    },
  },
});
function Fixture() {
  const [selected, select] = useState(0),
    [disabled, disable] = useState(false),
    [thread, toggleThread] = useState(false);
  const owner = owners[selected];
  if (!owner) return null;
  return (
    <main
      style={{ padding: 40, marginTop: 300, maxWidth: 800 }}
      onKeyDownCapture={publishOnKey}
    >
      <nav style={{ position: "fixed", top: 0, left: 0 }}>
        <button type="button" onClick={() => select(1 - selected)}>
          Switch session
        </button>
        <button type="button" onClick={() => disable(!disabled)}>
          Toggle disabled
        </button>
        <button type="button" onClick={() => toggleThread(!thread)}>
          Toggle destination
        </button>
      </nav>
      <conversation.ui.Composer
        session={owner.session}
        scope={String(selected)}
        channelId="c"
        channelName="Test"
        disabled={disabled}
        {...(thread ? { threadRootId: "a".repeat(64) } : {})}
      />
      <conversation.ui.Composer
        session={owner.session}
        scope={String(selected)}
        channelId="other"
        channelName="Other"
      />
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);

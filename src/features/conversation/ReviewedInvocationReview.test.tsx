// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Fragment, StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { invoke } from "@tauri-apps/api/core";
import {
  HostService,
  type ReviewedInvocationProjection,
  type ReviewedInvocationReceipt,
  type ReviewedInvocationRequest,
} from "../host/service";
import { PluginRuntime } from "../../plugins/runtime";
import { AppInvocation } from "../../buzz-mcp/app-client";
import type { AgentHandle } from "../agents/service";
import { formatPublicKey } from "../../shared/identity/public-key";
import { ConversationService } from "./service";
import { MessageBody } from "./MessageBody";
import type { ReviewReader } from "./ReviewedInvocationReview";
import { createRelaySession, type RelaySession } from "../relay/session";
import type { RelayData } from "../relay/service";
import type { ChannelMessage } from "../relay/contracts";
import type { PluginInfo } from "../../plugins/types";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(),
  Channel: class {
    constructor(public onmessage: (value: unknown) => void) {}
  },
}));
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  cleanup();
  for (const dispose of disposals.splice(0)) await dispose();
  vi.mocked(invoke).mockReset();
});
const callId = "abcdefab-1234-4234-8234-123456789abc";
const request = {
  operation: "synthetic",
  body: "Native frozen request",
  destination: {
    community: "fixture-community",
    viewer: "fixture-viewer",
    channel: "fixture-channel",
  },
};
const projection: ReviewedInvocationProjection = {
  callId,
  pluginId: "example.fixture",
  revision: "revision",
  request,
  digest: "ab".repeat(32),
  expiresAt: Date.now() + 120000,
};
const message = {
  id: "message",
  channelId: request.destination.channel,
  content: "Mutable plugin draft",
  attachments: [],
  participants: [],
  reactions: [],
} as unknown as ChannelMessage;

async function harness(
  productionRow = false,
  options: {
    request?: ReviewedInvocationRequest;
    reviewRoot?: string | null;
    unresolved?: boolean;
    row?: ChannelMessage;
    mount?: boolean;
    author?: ReviewedInvocationProjection["author"];
  } = {},
) {
  const operationRequest = options.request ?? request;
  const root = new Context();
  const host = new HostService(root);
  const local = createRelaySession(null);
  const session = {
    ...local.session,
    viewer: request.destination.viewer,
    scope: "fixture-community:fixture-viewer",
  } as RelaySession;
  let currentSession = session;
  const listeners = new Set<() => void>();
  root.provide("relay", {
    snapshot: () => ({
      origin: request.destination.community,
      session: currentSession,
    }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as RelayData);
  const terminal = gate<ReviewedInvocationReceipt>();
  let channel:
    | { onmessage(projection: ReviewedInvocationProjection): void }
    | undefined;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "plugin_host_call_context")
      return { boot: crypto.randomUUID(), page: 0 };
    if (command === "plugin_host_reviewed_invoke") {
      channel = (args as { onReview: typeof channel }).onReview;
      return terminal.promise;
    }
    return undefined;
  });
  const runtime = new PluginRuntime(root, async () => ({
    inject: ["host", "conversation"],
    apply(ctx) {
      ctx.conversation.registerMessage({
        id: "card",
        title: "Synthetic",
        matches: () => true,
        reviewedInvocation: () => callId,
        component: ({ message }) => <p>{message.content}</p>,
      });
      // An agent's call reaches the app's own host with its origin.
      const author = options.author;
      const origin = author && {
        invocation: new AppInvocation(
          {
            pubkey: author.pubkey,
            live: () => {},
            lifetime: () => new AbortController().signal,
          } as unknown as AgentHandle,
          operationRequest.destination,
          () => {},
        ),
        relay: author.relay,
        destination: operationRequest.destination,
      };
      void (ctx.host as HostService)
        .reviewAndInvokeOnce(
          operationRequest,
          { callId, onCreateResponse: () => {} },
          origin,
        )
        .catch(() => {});
    },
  }));
  const conversation = new ConversationService(root);
  const plugin: PluginInfo = {
    manifest: { id: "example.fixture", name: "Fixture", apiVersion: 1 },
    enabled: true,
    source: "external",
    revision: "revision",
    previous: null,
    reloadable: true,
    error: null,
  };
  runtime.reconcile([plugin]);
  await waitFor(() => {
    expect(conversation.messages.snapshot()).toHaveLength(1);
    expect(channel).toBeDefined();
  });
  const view = (
    reader: ReviewReader | null = {
      session,
      channel: request.destination.channel,
    },
    row = message,
  ) => (
    <StrictMode>
      <MessageBody
        registry={conversation.messages}
        message={row}
        reviewReader={reader ?? undefined}
      >
        Fallback
      </MessageBody>
    </StrictMode>
  );
  const rowView = () => (
    <StrictMode>
      <conversation.ui.Message
        row={{
          ...(options.row ?? message),
          authorId: "ab".repeat(32),
          createdAt: 1,
          mentions: [],
          replyCount: 0,
        }}
        session={session}
        reviewRoot={
          options.unresolved ? undefined : (options.reviewRoot ?? null)
        }
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />
    </StrictMode>
  );
  const mounted = render(
    options.mount === false ? null : productionRow ? rowView() : view(),
  );
  const offer = async (
    value = { ...projection, request: operationRequest },
  ) => {
    await act(async () => channel?.onmessage(value));
  };
  const finish = async (outcome: ReviewedInvocationReceipt["outcome"]) => {
    await act(async () =>
      terminal.resolve({
        callId,
        digest: projection.digest,
        destination: operationRequest.destination,
        outcome,
      }),
    );
  };
  disposals.push(async () => {
    terminal.resolve({
      callId,
      digest: projection.digest,
      destination: operationRequest.destination,
      outcome: "cancelled",
    });
    await runtime.dispose();
    local.dispose();
    await root.fiber.dispose();
  });
  return {
    host,
    runtime,
    plugin,
    conversation,
    session,
    mounted,
    view,
    rowView,
    offer,
    offerNow: () =>
      channel?.onmessage({ ...projection, request: operationRequest }),
    finish,
    switchSession: () => {
      currentSession = { ...session };
      for (const listener of listeners) listener();
    },
  };
}
function commands(name: string) {
  return vi.mocked(invoke).mock.calls.filter(([command]) => command === name);
}

it("mounts the real registered card, survives effect replay and dispatches frozen native data only once", async () => {
  const h = await harness();
  expect(
    screen.getByRole("button", { name: "Approve and run" }),
  ).toBeDisabled();
  await h.offer();
  expect(screen.getByText("Mutable plugin draft")).toBeVisible();
  expect(screen.getByText(request.body)).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Review this exact synthetic request. No provider will be called.",
  );
  expect(screen.queryByText(/Saved credential/)).toBeNull();
  expect(commands("plugin_host_reviewed_retire")).toHaveLength(0);
  const button = screen.getByRole("button", { name: "Approve and run" });
  act(() => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  expect(commands("plugin_host_reviewed_dispatch")).toEqual([
    [
      "plugin_host_reviewed_dispatch",
      {
        callId,
        id: projection.pluginId,
        revision: projection.revision,
        digest: projection.digest,
        destination: request.destination,
      },
    ],
  ]);
  expect(button).toBeDisabled();
  await h.finish("submitted");
  expect(screen.getByRole("status")).toHaveTextContent("submitted");
  expect(commands("plugin_host_reviewed_invoke")).toHaveLength(1);
});

it.each(["body", "digest", "destination", "root", "revision", "caller"])(
  "rejects an altered native projection (%s) before showing an actionable review",
  async (field) => {
    const h = await harness();
    const value = structuredClone(projection);
    if (field === "body") (value.request as { body: string }).body += "!";
    if (field === "digest") (value as { digest: string }).digest = "invalid";
    if (field === "destination")
      (value.request.destination as { channel: string }).channel += "x";
    if (field === "root")
      (value.request.destination as { root?: string }).root = "thread";
    if (field === "revision")
      (value as { revision: string }).revision = "stale";
    if (field === "caller") (value as { pluginId: string }).pluginId = "other";
    await h.offer(value);
    expect(commands("plugin_host_reviewed_retire")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Approve and run" }));
    expect(commands("plugin_host_reviewed_dispatch")).toHaveLength(0);
  },
);

it.each(["message", "channel", "root", "session"])(
  "retires the exact old card on %s replacement and cannot revive it",
  async (field) => {
    const h = await harness();
    await h.offer();
    const reader: ReviewReader = {
      session: field === "session" ? { ...h.session } : h.session,
      channel: field === "channel" ? "other" : request.destination.channel,
      ...(field === "root" ? { root: "thread" } : {}),
    };
    h.mounted.rerender(
      h.view(
        reader,
        field === "message" ? { ...message, content: "Edited draft" } : message,
      ),
    );
    // Before the queued unmount/replay distinction is resolved, a same-task
    // activation must already reject the old operation on replacement content.
    fireEvent.click(screen.getByRole("button", { name: "Approve and run" }));
    expect(commands("plugin_host_reviewed_dispatch")).toHaveLength(0);
    await waitFor(() =>
      expect(commands("plugin_host_reviewed_retire")).toHaveLength(1),
    );
    h.mounted.rerender(h.view());
    fireEvent.click(screen.getByRole("button", { name: "Approve and run" }));
    expect(commands("plugin_host_reviewed_dispatch")).toHaveLength(0);
    expect(commands("plugin_host_reviewed_invoke")).toHaveLength(1);
  },
);

it("refuses a stale registry callback before React removes the card", async () => {
  const h = await harness();
  await h.offer();
  const button = screen.getByRole("button", { name: "Approve and run" });
  act(() => {
    h.runtime.reconcile([]);
    fireEvent.click(button);
  });
  await waitFor(() =>
    expect(h.conversation.messages.snapshot()).toHaveLength(0),
  );
  expect(commands("plugin_host_reviewed_dispatch")).toHaveLength(0);
});

it("retires on session loss and ignores late projections after actual unmount", async () => {
  const h = await harness();
  act(() => h.switchSession());
  h.mounted.unmount();
  await h.offer();
  expect(h.host.reviewed.snapshot()?.projection).toBeUndefined();
  expect(commands("plugin_host_reviewed_retire")).toHaveLength(1);
  expect(commands("plugin_host_reviewed_dispatch")).toHaveLength(0);
});

it("keeps UNKNOWN consumed across a fresh mounted card", async () => {
  const h = await harness();
  await h.offer();
  fireEvent.click(screen.getByRole("button", { name: "Approve and run" }));
  await h.finish("unknown");
  h.mounted.unmount();
  render(h.view());
  expect(screen.getByRole("status")).toHaveTextContent("unknown");
  expect(
    screen.getByRole("button", { name: "Approve and run" }),
  ).toBeDisabled();
  expect(commands("plugin_host_reviewed_invoke")).toHaveLength(1);
  expect(commands("plugin_host_reviewed_dispatch")).toHaveLength(1);
});

it("uses production MessageRow reader-context forwarding for the registered review", async () => {
  const h = await harness(true);
  await h.offer();
  fireEvent.click(screen.getByRole("button", { name: "Approve and run" }));
  expect(commands("plugin_host_reviewed_dispatch")).toHaveLength(1);
  await h.finish("submitted");
  expect(screen.getByRole("status")).toHaveTextContent("submitted");
});

it.each(["root", "reply"])(
  "uses the authoritative thread target for a production %s row",
  async (kind) => {
    const threadRequest = {
      ...request,
      destination: { ...request.destination, root: "thread" },
    };
    const h = await harness(true, {
      request: threadRequest,
      reviewRoot: "thread",
      row: { ...message, id: kind === "root" ? "thread" : "reply" },
    });
    await h.offer();
    fireEvent.click(screen.getByRole("button", { name: "Approve and run" }));
    expect(commands("plugin_host_reviewed_dispatch")).toHaveLength(1);
    expect(commands("plugin_host_reviewed_dispatch")[0]?.[1]).toMatchObject({
      destination: threadRequest.destination,
    });
    await h.finish("submitted");
  },
);

it.each(["thread", "unresolved"])(
  "never treats a %s reader target as intentionally absent root",
  async (kind) => {
    const h = await harness(
      true,
      kind === "thread" ? { reviewRoot: "thread" } : { unresolved: true },
    );
    await h.offer();
    fireEvent.click(screen.getByRole("button", { name: "Approve and run" }));
    expect(commands("plugin_host_reviewed_dispatch")).toHaveLength(0);
  },
);

it("refuses a fresh pending instance in the same task before queued retirement", async () => {
  const h = await harness();
  await h.offer();
  h.mounted.unmount();
  render(h.view());
  fireEvent.click(screen.getByRole("button", { name: "Approve and run" }));
  expect(commands("plugin_host_reviewed_dispatch")).toHaveLength(0);
  await waitFor(() =>
    expect(commands("plugin_host_reviewed_retire")).toHaveLength(1),
  );
  expect(commands("plugin_host_reviewed_invoke")).toHaveLength(1);
});

it.each(["channel", "unresolved", "session"])(
  "lets only the eligible retained reader claim when %s mounts first before projection",
  async (kind) => {
    const threadRequest = {
      ...request,
      destination: { ...request.destination, root: "thread" },
    };
    const h = await harness(false, { request: threadRequest, mount: false });
    const target = {
      session: h.session,
      channel: request.destination.channel,
      root: "thread",
    };
    const wrong = h.view(
      kind === "unresolved"
        ? null
        : kind === "session"
          ? { ...target, session: { ...h.session } }
          : { session: h.session, channel: request.destination.channel },
    );
    const correct = h.view(target);
    const pair = (showWrong: boolean) => (
      <>
        {showWrong && <Fragment key="wrong">{wrong}</Fragment>}
        <Fragment key="correct">{correct}</Fragment>
      </>
    );
    h.mounted.rerender(pair(true));
    await h.offer();
    const buttons = screen.getAllByRole("button", { name: "Approve and run" });
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).toBeEnabled();
    h.mounted.rerender(pair(false));
    await act(async () => {});
    expect(commands("plugin_host_reviewed_retire")).toHaveLength(0);
    const button = screen.getByRole("button", { name: "Approve and run" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(commands("plugin_host_reviewed_dispatch")).toHaveLength(1);
    expect(commands("plugin_host_reviewed_dispatch")[0]?.[1]).toMatchObject({
      destination: threadRequest.destination,
    });
    await h.finish("submitted");
  },
);

it("cannot reopen the eligible original mount replaced before the native projection", async () => {
  const h = await harness();
  h.mounted.unmount();
  render(h.view());
  act(() => h.offerNow());
  fireEvent.click(screen.getByRole("button", { name: "Approve and run" }));
  expect(commands("plugin_host_reviewed_dispatch")).toHaveLength(0);
  await waitFor(() =>
    expect(commands("plugin_host_reviewed_retire")).toHaveLength(1),
  );
});

it("binds an unresolved instance only once its exact reader becomes eligible", async () => {
  const h = await harness(false, { mount: false });
  h.mounted.rerender(h.view(null));
  await h.offer();
  expect(
    screen.getByRole("button", { name: "Approve and run" }),
  ).toBeDisabled();
  h.mounted.rerender(h.view());
  expect(screen.getByRole("button", { name: "Approve and run" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Approve and run" }));
  expect(commands("plugin_host_reviewed_dispatch")).toHaveLength(1);
  expect(commands("plugin_host_reviewed_retire")).toHaveLength(0);
});

it("shows a versioned request's actual transport, with plugin notes only as a supplement", async () => {
  const versioned: ReviewedInvocationRequest = {
    ...request,
    version: 1,
    body: '{"prompt":"Exact body"}',
    effect: {
      kind: "credential-http",
      method: "POST",
      url: "https://api.example.test/v1/create",
      headers: { "x-version": "2024-11-06" },
      slot: "api-key",
    },
    disclosure: { version: "example/1", text: "About one credit" },
  };
  const h = await harness(false, { request: versioned });
  await h.offer();
  expect(
    screen.getByText(
      "POST https://api.example.test/v1/create · Saved credential: api-key",
    ),
  ).toBeVisible();
  expect(screen.getByText(versioned.body)).toBeVisible();
  expect(screen.getByText("Plugin notes: About one credit")).toBeVisible();
  expect(
    screen.getByText(/Headers: x-version: 2024-11-06/),
  ).toBeInTheDocument();
  expect(screen.getByText(/fixture-channel/)).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Review this exact request. Approving sends it once and can’t be undone.",
  );
  expect(screen.queryByText(/No provider will be called/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Approve and run" }));
  expect(commands("plugin_host_reviewed_dispatch")).toHaveLength(1);
});

it("states the native-projected expected result once, unchanged by later mutation", async () => {
  const media = {
    version: 1 as const,
    kind: "video" as const,
    container: "mp4" as const,
    codec: "h264" as const,
    width: 1280,
    height: 720,
    durationMs: 5000,
    toleranceMs: 50,
    maxBytes: 16 * 1024 * 1024,
  };
  const versioned: ReviewedInvocationRequest = {
    ...request,
    version: 1,
    body: "{}",
    effect: {
      kind: "credential-http",
      method: "POST",
      url: "https://api.example.test/v1/create",
      headers: {},
      slot: "api-key",
    },
    disclosure: { version: "example/1", text: "About one credit" },
    expectedMedia: media,
  };
  const h = await harness(false, { request: versioned });
  const projected = structuredClone({ ...projection, request: versioned });
  await h.offer(projected);
  const line =
    "Expected result: 1280×720 MP4 (H.264) · 5 s ± 50 ms · up to 16 MB";
  expect(screen.getByText(line)).toBeVisible();
  (projected.request.expectedMedia as { width: number }).width = 1;
  h.mounted.rerender(h.view());
  expect(screen.getAllByText(line)).toHaveLength(1);
  expect(screen.queryByText(/Expected result: 1×/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Approve and run" }));
  expect(commands("plugin_host_reviewed_dispatch")).toHaveLength(1);
});

it("shows no expected result line without expected media", async () => {
  const h = await harness();
  await h.offer();
  expect(screen.queryByText(/Expected result:/)).toBeNull();
  expect(screen.queryByText(/Download one result/)).toBeNull();
});

it("states a host-derived result download only when native projects it", async () => {
  const h = await harness();
  await h.offer({ ...projection, resultUrl: 1 });
  expect(
    screen.getByText(
      "Download one result from the service’s response · no credential sent",
    ),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Approve and run" }));
  expect(commands("plugin_host_reviewed_dispatch")).toHaveLength(1);
});

it("names the agent a review sends as, with its full key in Details", async () => {
  const author = { pubkey: "cd".repeat(32), relay: "wss://fixture.test" };
  const h = await harness(false, { author });
  await h.offer({ ...projection, author });
  expect(
    screen.getByText(`As agent: ${formatPublicKey(author.pubkey)}`),
  ).toBeVisible();
  expect(screen.getByText(new RegExp(`Agent: ${author.pubkey}`))).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Approve and run" }));
  expect(commands("plugin_host_reviewed_dispatch")).toHaveLength(1);
});

it("names no agent on a plugin's own review", async () => {
  const h = await harness();
  await h.offer();
  expect(screen.queryByText(/As agent:|Agent:/)).toBeNull();
});

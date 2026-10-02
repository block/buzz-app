// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { communityFromScope } from "../relay/gifs";
import { createRelaySession } from "../relay/session";
import { readView, writeView } from "../../shared/view-state";
import { createHuddleComposerOwner } from "./composer-owner";
import { createHuddleComposerClient } from "./composer-client";
import type { ComposerCommand, ComposerResponse } from "./composer-contract";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  localStorage.clear();
});
function harness(legacy = false) {
  const store = createRelaySession(null);
  const viewer = "ab".repeat(32),
    room = "room",
    parent = "parent",
    scope = `https://example.test:${viewer}`;
  let allowed = true;
  const metadata = {
    id: room,
    name: "Huddle",
    huddle: true as const,
    parentChannelId: legacy ? undefined : parent,
    members: [viewer],
  };
  const send = vi.fn(() => "accepted-id");
  const refresh = vi.fn(async () => {});
  const session = {
    ...store.session,
    viewer,
    scope,
    channels: { ...store.session.channels, get: () => metadata },
    messages: { ...store.session.messages, send },
    agentChoices: { ...store.session.agentChoices, refresh },
  };
  let verified = !legacy;
  const owner = createHuddleComposerOwner(
    session,
    room,
    parent,
    undefined,
    () => allowed,
    legacy ? () => verified : undefined,
  );
  cleanup.push(
    () => store.dispose(),
    () => owner.dispose(),
  );
  const connect = async () => {
    const client = createHuddleComposerClient(owner.token);
    cleanup.push(() => client.dispose());
    await vi.waitFor(() => expect(client.snapshot().session).toBeDefined());
    const remote = client.snapshot().session;
    if (!remote) throw new Error("Missing session");
    return { client, remote };
  };
  return {
    owner,
    verify: (value: boolean) => {
      verified = value;
      owner.refresh();
    },
    send,
    refresh,
    scope,
    connect,
    revoke: () => {
      allowed = false;
    },
  };
}
it("keeps drafts on rejection, clears persisted accepted intent in main, and refreshes mention evidence", async () => {
  const h = harness();
  const { remote, client } = await h.connect();
  expect(client.snapshot().data?.scope).toBe(h.scope);
  expect(communityFromScope(remote.scope)).toBe("https://example.test");
  const draft = { text: "Hello", recipients: [] };
  writeView(h.scope, "draft:room", draft);
  h.send.mockImplementationOnce(() => {
    throw new Error("Rejected");
  });
  await expect(remote.messages.send("room", "Hello")).rejects.toThrow(
    "Rejected",
  );
  expect(readView(h.scope, "draft:room", null)).toEqual(draft);
  await expect(remote.messages.send("room", "Hello")).resolves.toBe(
    "accepted-id",
  );
  expect(readView(h.scope, "draft:room", null)).toBe("");
  await remote.agentChoices.refresh();
  expect(h.refresh).toHaveBeenCalledWith(true);
  h.revoke();
  await expect(remote.messages.send("room", "Again")).rejects.toThrow(
    "no longer available",
  );
  expect(h.send).toHaveBeenCalledTimes(2);
});
it("clears admitted drafts even when the child closes before acknowledgment and deduplicates request IDs", async () => {
  const h = harness();
  const peer = new BroadcastChannel(`buzz.huddle.composer.${h.owner.token}`);
  cleanup.push(() => peer.close());
  const responses: ComposerResponse[] = [];
  peer.onmessage = ({ data }) => responses.push(data);
  const post = (command: ComposerCommand) => peer.postMessage(command);
  post({ kind: "hello", client: "test" });
  await vi.waitFor(() =>
    expect(responses.some((r) => r.kind === "snapshot")).toBe(true),
  );
  const draft = { text: "Accepted before close", recipients: [] };
  writeView(h.scope, "draft:room", draft);
  const command: ComposerCommand = {
    kind: "request",
    client: "test",
    id: 1,
    op: "send",
    args: {
      text: draft.text,
      draft: JSON.stringify(draft),
      mentions: [],
      references: [],
      attachments: [],
    },
  };
  post(command);
  post(command);
  await vi.waitFor(() =>
    expect(responses.some((r) => r.kind === "result" && r.id === 1)).toBe(true),
  );
  expect(h.send).toHaveBeenCalledTimes(1);
  // Closing the renderer in the enqueue callback happens before main can reply.
  const next = { text: "Close immediately", recipients: [] };
  writeView(h.scope, "draft:room", next);
  h.send.mockImplementationOnce(() => {
    peer.close();
    return "second-id";
  });
  post({
    ...command,
    id: 2,
    args: { ...command.args, text: next.text, draft: JSON.stringify(next) },
  });
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
  expect(readView(h.scope, "draft:room", null)).toBe("");
  const { remote } = await h.connect();
  expect(readView(h.scope, "draft:room", null)).toBe("");
  await expect(remote.messages.send("other", "Wrong room")).rejects.toThrow(
    "destination changed",
  );
  expect(h.send).toHaveBeenCalledTimes(2);
});

it("keeps the legacy composer disabled until parent verification and rechecks before sending", async () => {
  const h = harness(true);
  const { client, remote } = await h.connect();
  await expect(remote.messages.send("room", "Unverified")).rejects.toThrow(
    "no longer available",
  );
  h.verify(true);
  await vi.waitFor(() => expect(client.snapshot().data?.writable).toBe(true));
  await expect(remote.messages.send("room", "Verified")).resolves.toBe(
    "accepted-id",
  );
  h.verify(false);
  await expect(remote.messages.send("room", "Revoked")).rejects.toThrow(
    "no longer available",
  );
  expect(h.send).toHaveBeenCalledTimes(1);
});

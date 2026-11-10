// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { communityRequest } from "../../features/communities/api";
import { soloForkTarget } from "../../features/channel-navigation/routes";
import type { Navigation } from "../../features/navigation/controller";
import type { PageNavigation } from "../../features/navigation/service";
import { createRelaySession } from "../../features/relay/session";
import { eventDto } from "../../features/relay/events";
import type { Outbox, OutgoingEvent } from "../../features/relay/outbox";
import { keypair, message } from "../../features/relay/testing";
import { readView, writeView } from "../../shared/view-state";
import { SoloForkDialog, canForkSolo } from "./ForkSoloChat";

vi.mock("../../features/communities/api", () => ({
  communityRequest: vi.fn(),
}));
const viewer = "a".repeat(64),
  agent = "b".repeat(64);
const scope = `https://relay.example:${viewer}`;
const sourceId = "11111111-1111-4111-8111-111111111111";
const destination = "22222222-2222-4222-8222-222222222222";
const key = `solo:fork:${destination}`;
const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  disposals.splice(0).forEach((close) => {
    close();
  });
  localStorage.clear();
  vi.clearAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const owner = createRelaySession(null);
  disposals.push(owner.dispose);
  const relay = keypair();
  const cutoff = eventDto(message(keypair(), sourceId, "Parent context", 10));
  const draft = { channelId: sourceId, messageId: cutoff.id, destination };
  const controller = new AbortController();
  const source = {
    id: sourceId,
    name: "Parent",
    channelType: "solo" as const,
    creator: viewer,
    members: [viewer],
  };
  const choices = {
    ...owner.session.agentChoices.snapshot(),
    selectable: [
      {
        pubkey: agent,
        name: "Claude",
        runtime: "claude",
        managed: true,
        owner: viewer,
      },
    ],
  };
  const start = vi
    .fn(owner.session.channelWrites.start)
    .mockImplementation(() => ({
      create: "c".repeat(64),
      ready: new Promise(() => {}),
    }));
  const readRemote = vi
    .fn(owner.session.readRemote)
    .mockResolvedValue([cutoff]);
  const resolve = vi.fn(async () => {});
  let destinationClaim = false;
  const session = {
    ...owner.session,
    relayAuthor: relay.pubkey,
    viewer,
    scope,
    channels: {
      ...owner.session.channels,
      resolve,
      get: (id: string) =>
        id === sourceId
          ? source
          : destinationClaim
            ? { id: destination, name: "Fork", forkClaim: true as const }
            : undefined,
    },
    agentChoices: {
      ...owner.session.agentChoices,
      snapshot: () => choices,
      ensure: vi.fn(),
    },
    channelWrites: { ...owner.session.channelWrites, available: true, start },
    readRemote,
  };
  const open = vi
    .fn<Navigation["open"]>()
    .mockResolvedValue({ status: "opened" });
  const dismiss = vi.fn<Navigation["dismiss"]>();
  const navigation = {
    ...({} as Navigation),
    open,
    dismiss,
    snapshot: () =>
      ({ attempt: { id: "attempt" } }) as ReturnType<Navigation["snapshot"]>,
  };
  const visit = {
    ...({} as PageNavigation),
    entryId: "visit",
    target: soloForkTarget(scope, draft),
    signal: controller.signal,
  };
  vi.mocked(communityRequest).mockResolvedValue({
    soloFork: true,
    policy: null,
  });
  writeView(scope, key, { title: "Fork", agent });
  const show = () =>
    render(
      <SoloForkDialog
        session={session}
        navigation={navigation}
        visit={visit}
        draft={draft}
      />,
    );
  return {
    session,
    start,
    readRemote,
    open,
    dismiss,
    visit,
    controller,
    source,
    show,
    draft,
    relay,
    resolve,
    navigation,
    confirmDestination: () => {
      destinationClaim = true;
    },
  };
}

it("hands off without awaiting ancestry, fences double submission and restores only the original destination", async () => {
  const h = setup();
  const gate = deferred<{ soloFork: boolean; policy: null }>();
  vi.mocked(communityRequest).mockReturnValue(gate.promise);
  const mounted = h.show();
  const create = screen.getByRole("button", { name: "Create fork" });
  fireEvent.click(create);
  fireEvent.click(create);
  expect(communityRequest).toHaveBeenCalledOnce();
  expect(h.start).not.toHaveBeenCalled();
  try {
    await act(async () => gate.resolve({ soloFork: true, policy: null }));
    await waitFor(() => expect(h.start).toHaveBeenCalledOnce());
    expect(h.start).toHaveBeenCalledWith(
      destination,
      "Fork",
      [agent],
      undefined,
      true,
      undefined,
      { forkedFrom: { channelId: sourceId, messageId: h.draft.messageId } },
    );
    await waitFor(() => expect(h.dismiss).toHaveBeenCalledOnce());
    expect(h.open.mock.calls[0]?.[0]).toMatchObject({
      kind: "conversation",
      channelId: destination,
    });
    expect(readView(scope, key, null)).toEqual({
      title: "Fork",
      agent,
      submitted: true,
    });
    mounted.unmount();
    h.confirmDestination();
    h.show();
    expect(screen.queryByRole("button", { name: "Create fork" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Check submission / open fork" }),
    );
    await waitFor(() => expect(h.open).toHaveBeenCalledTimes(2));
    expect(h.start).toHaveBeenCalledOnce();
  } finally {
    await act(async () => gate.resolve({ soloFork: true, policy: null }));
  }
});

it("keeps the enqueued destination when navigation fails, without a second ancestry error surface", async () => {
  const h = setup();
  h.open.mockResolvedValue({ status: "failed", reason: "host-error" });
  h.start.mockReturnValue({
    create: "c".repeat(64),
    ready: Promise.reject(new Error("Missing signed ancestry")),
  });
  h.show();
  fireEvent.click(screen.getByRole("button", { name: "Create fork" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "destination couldn’t open",
  );
  expect(screen.queryByText("Missing signed ancestry")).toBeNull();
  expect(h.dismiss).not.toHaveBeenCalled();
  h.confirmDestination();
  fireEvent.click(
    screen.getByRole("button", { name: "Check submission / open fork" }),
  );
  await waitFor(() => expect(h.open).toHaveBeenCalledTimes(2));
  expect(h.start).toHaveBeenCalledOnce();
});

it.each(["unsupported", "missing-cutoff", "sync-rejection"])(
  "keeps pre-enqueue failures in the form: %s",
  async (failure) => {
    const h = setup();
    if (failure === "unsupported")
      vi.mocked(communityRequest).mockResolvedValue({ soloFork: false });
    if (failure === "missing-cutoff") h.readRemote.mockResolvedValue([]);
    if (failure === "sync-rejection")
      h.start.mockImplementation(() => {
        throw new Error("Signing admission unavailable");
      });
    h.show();
    fireEvent.click(screen.getByRole("button", { name: "Create fork" }));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(h.open).not.toHaveBeenCalled();
    expect(
      readView<{ submitted?: true }>(scope, key, {}).submitted,
    ).toBeUndefined();
    expect(screen.getByRole("button", { name: "Create fork" })).toBeEnabled();
  },
);

it("passive traversal/unmount during preflight never submits or dismisses, and Forward restores draft text", async () => {
  const h = setup();
  const gate = deferred<{ soloFork: boolean }>();
  vi.mocked(communityRequest).mockReturnValue(gate.promise);
  const mounted = h.show();
  fireEvent.change(screen.getByRole("textbox", { name: "Chat title" }), {
    target: { value: "Edited fork" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create fork" }));
  h.controller.abort();
  mounted.unmount();
  await act(async () => gate.resolve({ soloFork: true }));
  expect(h.start).not.toHaveBeenCalled();
  expect(h.open).not.toHaveBeenCalled();
  expect(h.dismiss).not.toHaveBeenCalled();
  expect(readView(scope, key, null)).toEqual({ title: "Edited fork", agent });
});

it("explicit Cancel retires only the scoped fork presentation", () => {
  const h = setup();
  h.show();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  const call = h.dismiss.mock.calls[0];
  if (!call) throw new Error("Expected dismissal");
  const [matches, fallback] = call;
  expect(typeof matches).toBe("function");
  if (typeof matches !== "function")
    throw new Error("Expected logical presentation predicate");
  expect(matches(h.visit.target)).toBe(true);
  expect(
    matches(
      soloForkTarget(scope, {
        ...h.draft,
        destination: "33333333-3333-4333-8333-333333333333",
      }),
    ),
  ).toBe(false);
  expect(
    matches(soloForkTarget(`https://other.example:${viewer}`, h.draft)),
  ).toBe(false);
  expect(fallback).toMatchObject({ kind: "conversation", channelId: sourceId });
  expect(h.start).not.toHaveBeenCalled();
});

it("rechecks ownership, lifetime and Claude selection at submission", async () => {
  const h = setup();
  expect(canForkSolo(h.session, sourceId)).toBe(true);
  h.source.creator = "e".repeat(64);
  expect(canForkSolo(h.session, sourceId)).toBe(false);
  h.show();
  expect(screen.getByRole("button", { name: "Create fork" })).toBeDisabled();
  expect(h.start).not.toHaveBeenCalled();
});

it("reports a stranded pre-enqueue fence loudly and retries evidence, never signs a replacement", async () => {
  const h = setup();
  writeView(scope, key, { title: "Fork", agent, submitted: true });
  h.readRemote.mockResolvedValue([]);
  const mounted = h.show();
  const check = () =>
    fireEvent.click(
      screen.getByRole("button", { name: "Check submission / open fork" }),
    );
  check();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Submission unresolved",
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Retained create: unavailable. Destination: no claim found.",
  );
  expect(
    screen.getByText(/Last checked:/).querySelector("time"),
  ).toHaveAttribute("datetime");
  expect(h.open).not.toHaveBeenCalled();
  expect(h.start).not.toHaveBeenCalled();
  h.confirmDestination();
  check();
  await waitFor(() => expect(h.open).toHaveBeenCalledOnce());
  expect(h.start).not.toHaveBeenCalled();
  mounted.unmount();
});

it("uses a retained create without reading ancestry in the form or enqueueing again", async () => {
  const h = setup();
  writeView(scope, key, { title: "Fork", agent, submitted: true });
  const recovery = vi.fn(
    async () => ({ event: { id: "d".repeat(64) } }) as OutgoingEvent,
  );
  render(
    <SoloForkDialog
      session={{ ...h.session, outbox: { ...({} as Outbox), recovery } }}
      navigation={h.navigation}
      visit={h.visit}
      draft={h.draft}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Check submission / open fork" }),
  );
  await waitFor(() => expect(h.open).toHaveBeenCalledOnce());
  expect(recovery).toHaveBeenCalledWith(`solo-fork:${destination}`);
  expect(h.resolve).not.toHaveBeenCalled();
  expect(h.start).not.toHaveBeenCalled();
  expect(h.readRemote).not.toHaveBeenCalled();
});

it("revokes a submission check when its visit is left", async () => {
  const h = setup();
  writeView(scope, key, { title: "Fork", agent, submitted: true });
  const gate = deferred<void>();
  h.resolve.mockReturnValue(gate.promise);
  h.show();
  fireEvent.click(
    screen.getByRole("button", { name: "Check submission / open fork" }),
  );
  await waitFor(() => expect(h.resolve).toHaveBeenCalledOnce());
  h.controller.abort();
  h.confirmDestination();
  await act(async () => gate.resolve());
  expect(h.open).not.toHaveBeenCalled();
  expect(h.start).not.toHaveBeenCalled();
  expect(h.dismiss).not.toHaveBeenCalled();
});

it("reports failed evidence reads as unknown, not absent", async () => {
  const h = setup();
  writeView(scope, key, { title: "Fork", agent, submitted: true });
  h.resolve.mockRejectedValue(new Error("Relay unavailable"));
  h.show();
  fireEvent.click(
    screen.getByRole("button", { name: "Check submission / open fork" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Relay unavailable",
  );
  expect(screen.getByRole("status")).toHaveTextContent("Destination: unknown");
  expect(h.start).not.toHaveBeenCalled();
});

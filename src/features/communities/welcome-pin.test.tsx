// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SnapshotRead } from "../agents/agent-config-artifacts";
import type { ReadFilter, RelayEvent } from "../relay/events";
import { matchesEvent } from "../relay/projection";
import { readView, viewRevision, writeView } from "../../shared/view-state";
import {
  recordWelcomeFirstOpen,
  usePinnedWelcome,
  WELCOME_EARLIER_ACTIVITY_KEY,
  WELCOME_FIRST_OPEN_KEY,
  welcomeDismissedKey,
} from "./welcome-pin";
import { PinnedWelcome } from "./WelcomeCard";

const origin = "https://primary.example";
const me = "a".repeat(64);
const other = "b".repeat(64);
const scope = `${origin}:${me}`;
const channel = "11111111-1111-4111-8111-111111111111";
const moved = "22222222-2222-4222-8222-222222222222";
/** When this device first opened the community. */
const T = 1_788_810_000;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const authored = (pubkey: string, createdAt: number) =>
  ({
    id: createdAt.toString(16).padStart(64, "0"),
    pubkey,
    created_at: createdAt,
    kind: 9,
    content: "hello",
    tags: [["h", "general"]],
  }) as unknown as RelayEvent;

/** A relay holding `events`. Each read waits until the test answers it, with
 * what the relay would return for its filters, or with a failure. */
function fakeRelay(events: RelayEvent[] = []) {
  const reads: {
    filters: readonly ReadFilter[];
    answer(): Promise<void>;
    fail(): Promise<void>;
  }[] = [];
  const snapshotRead: SnapshotRead = (filters) =>
    new Promise((resolve, reject) => {
      reads.push({
        filters,
        answer: () =>
          act(async () => {
            resolve(
              events.filter((event) =>
                filters.some((filter) => matchesEvent(event, filter)),
              ),
            );
            await Promise.resolve();
          }),
        fail: () =>
          act(async () => {
            reject(new Error("Relay is disconnected"));
            await Promise.resolve();
          }),
      });
    });
  return { reads, snapshotRead };
}

/** The welcome channel's slot as Messages composes it. */
function Slot({
  relay,
  viewer = me,
  channelId = channel,
  title,
  message = "Say hi",
  onRender,
}: {
  relay: ReturnType<typeof fakeRelay> | undefined;
  viewer?: string;
  channelId?: string;
  title?: string;
  message?: string;
  /** Sees what each render decided, in order. */
  onRender?: (shown: boolean) => void;
}) {
  const welcome = usePinnedWelcome({
    session: { viewer, snapshotRead: relay?.snapshotRead },
    scope: `${origin}:${viewer}`,
    channelId,
    member: true,
  });
  onRender?.(welcome.shown);
  return welcome.shown ? (
    <PinnedWelcome
      scope={`${origin}:${viewer}`}
      title={title}
      onDismiss={() => welcome.dismiss()}
      onHeightChange={() => {}}
    >
      <p>{message}</p>
    </PinnedWelcome>
  ) : null;
}

it("records this device's first open once per relay, for every identity", () => {
  recordWelcomeFirstOpen(scope, T * 1000 + 999);
  recordWelcomeFirstOpen(`${origin}:${other}`, (T + 60) * 1000);
  // Scoped by relay alone, and never replaced.
  expect(readView(origin, WELCOME_FIRST_OPEN_KEY, undefined)).toBe(T);
  expect(viewRevision(scope, WELCOME_FIRST_OPEN_KEY)).toBeNull();
});

it("shows a new member the welcome once the relay has nothing earlier by them", async () => {
  writeView(origin, WELCOME_FIRST_OPEN_KEY, T);
  const relay = fakeRelay();
  render(<Slot relay={relay} title="Hello, newcomer" />);
  await waitFor(() => expect(relay.reads).toHaveLength(1));
  // Nothing shows while the answer is pending.
  expect(screen.queryByRole("region")).toBeNull();
  await relay.reads[0]?.answer();
  const card = screen.getByRole("region", { name: "Hello, newcomer" });
  expect(card).toHaveTextContent("Say hi");
  expect(card).toContainElement(
    screen.getByRole("button", { name: "Dismiss" }),
  );
  expect(card).not.toContainElement(document.activeElement as HTMLElement);
  expect(readView(scope, WELCOME_EARLIER_ACTIVITY_KEY, undefined)).toBe(false);
});

it("never shows the welcome to a member with an older event, and asks only once", async () => {
  writeView(origin, WELCOME_FIRST_OPEN_KEY, T);
  const relay = fakeRelay([authored(me, T - 86_400)]);
  const { unmount } = render(<Slot relay={relay} />);
  await waitFor(() => expect(relay.reads).toHaveLength(1));
  await relay.reads[0]?.answer();
  expect(readView(scope, WELCOME_EARLIER_ACTIVITY_KEY, undefined)).toBe(true);
  expect(screen.queryByRole("region")).toBeNull();
  unmount();
  // The answer is kept for this relay and viewer on this device.
  render(<Slot relay={relay} />);
  await act(async () => {});
  expect(relay.reads).toHaveLength(1);
  expect(screen.queryByRole("region")).toBeNull();
  cleanup();
  // Another identity on this device asks about itself.
  render(<Slot relay={relay} viewer={other} />);
  await waitFor(() => expect(relay.reads).toHaveLength(2));
  expect(relay.reads[1]?.filters).toStrictEqual([
    { authors: [other], until: T - 600, limit: 1 },
  ]);
});

it("counts an event from the ten minutes before the first open as new, with one kindless read", async () => {
  writeView(origin, WELCOME_FIRST_OPEN_KEY, T);
  const relay = fakeRelay([authored(me, T - 300)]);
  render(<Slot relay={relay} />);
  await waitFor(() => expect(relay.reads).toHaveLength(1));
  // Any kind, in any channel the relay lets this viewer read: no kinds, no #h.
  expect(relay.reads[0]?.filters).toStrictEqual([
    { authors: [me], until: T - 600, limit: 1 },
  ]);
  await relay.reads[0]?.answer();
  expect(screen.getByRole("region", { name: "Welcome" })).toBeVisible();
});

it("shows a kept answer in the first commit, without asking again", () => {
  writeView(origin, WELCOME_FIRST_OPEN_KEY, T);
  writeView(scope, WELCOME_EARLIER_ACTIVITY_KEY, false);
  const relay = fakeRelay();
  const renders: boolean[] = [];
  render(<Slot relay={relay} onRender={(shown) => renders.push(shown)} />);
  expect(renders[0]).toBe(true);
  expect(screen.getByRole("region", { name: "Welcome" })).toBeVisible();
  expect(relay.reads).toHaveLength(0);
});

it("keeps nothing from a failed read and asks again on the next open, not in the same one", async () => {
  writeView(origin, WELCOME_FIRST_OPEN_KEY, T);
  const relay = fakeRelay();
  const { rerender, unmount } = render(<Slot relay={relay} />);
  await waitFor(() => expect(relay.reads).toHaveLength(1));
  await relay.reads[0]?.fail();
  expect(screen.queryByRole("region")).toBeNull();
  expect(viewRevision(scope, WELCOME_EARLIER_ACTIVITY_KEY)).toBeNull();
  // Rendering again is not a new open: the same mount never retries.
  rerender(<Slot relay={relay} />);
  await act(async () => {});
  expect(relay.reads).toHaveLength(1);
  unmount();
  render(<Slot relay={relay} />);
  await waitFor(() => expect(relay.reads).toHaveLength(2));
  await relay.reads[1]?.answer();
  expect(screen.getByRole("region", { name: "Welcome" })).toBeVisible();
});

it("asks nothing without a session or a recorded first open", async () => {
  const relay = fakeRelay();
  render(<Slot relay={relay} />);
  await act(async () => {});
  expect(relay.reads).toHaveLength(0);
  cleanup();
  writeView(origin, WELCOME_FIRST_OPEN_KEY, T);
  render(<Slot relay={undefined} />);
  await act(async () => {});
  expect(screen.queryByRole("region")).toBeNull();
  expect(viewRevision(scope, WELCOME_EARLIER_ACTIVITY_KEY)).toBeNull();
});

it("stays dismissed on this device after a reload", async () => {
  writeView(origin, WELCOME_FIRST_OPEN_KEY, T);
  const relay = fakeRelay();
  const { unmount } = render(<Slot relay={relay} />);
  await waitFor(() => expect(relay.reads).toHaveLength(1));
  await relay.reads[0]?.answer();
  await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByRole("region")).toBeNull();
  // Scoped by relay alone and keyed by the channel.
  expect(readView(origin, welcomeDismissedKey(channel), undefined)).toBe(true);
  unmount();
  render(<Slot relay={relay} />);
  await act(async () => {});
  expect(screen.queryByRole("region")).toBeNull();
  expect(relay.reads).toHaveLength(1);
});

it("stays dismissed when an admin changes the welcome afterwards", async () => {
  writeView(origin, WELCOME_FIRST_OPEN_KEY, T);
  const relay = fakeRelay();
  const { rerender, unmount } = render(
    <Slot relay={relay} title="Hello" message="First" />,
  );
  await waitFor(() => expect(relay.reads).toHaveLength(1));
  await relay.reads[0]?.answer();
  await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  rerender(<Slot relay={relay} title="Hello again" message="Edited" />);
  await act(async () => {});
  expect(screen.queryByRole("region")).toBeNull();
  unmount();
  render(<Slot relay={relay} title="Hello again" message="Edited" />);
  await act(async () => {});
  expect(screen.queryByRole("region")).toBeNull();
  expect(screen.queryByText("Edited")).toBeNull();
});

it("shows the welcome once more in a channel it moves to, and never again where it was dismissed", async () => {
  writeView(origin, WELCOME_FIRST_OPEN_KEY, T);
  const relay = fakeRelay();
  const { rerender, unmount } = render(<Slot relay={relay} />);
  await waitFor(() => expect(relay.reads).toHaveLength(1));
  await relay.reads[0]?.answer();
  await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByRole("region")).toBeNull();
  // An admin moves the welcome to another channel: a new welcome, served by
  // the kept answer without another read.
  rerender(<Slot relay={relay} channelId={moved} />);
  expect(screen.getByRole("region", { name: "Welcome" })).toBeVisible();
  expect(relay.reads).toHaveLength(1);
  expect(
    readView(origin, welcomeDismissedKey(moved), undefined),
  ).toBeUndefined();
  // Moved back, it stays dismissed there, on this and the next open.
  rerender(<Slot relay={relay} channelId={channel} />);
  expect(screen.queryByRole("region")).toBeNull();
  unmount();
  render(<Slot relay={relay} channelId={channel} />);
  await act(async () => {});
  expect(screen.queryByRole("region")).toBeNull();
  expect(relay.reads).toHaveLength(1);
});

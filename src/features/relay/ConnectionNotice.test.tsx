// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { ConnectionNotice, connectionInTrouble } from "./ConnectionNotice";
import {
  createRecovery,
  RECOVERY_NOTICE_DELAY_MS,
  type RecoverySource,
} from "./recovery";
import type { RelaySnapshot } from "./service";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type Connection = Pick<
  RelaySnapshot,
  "status" | "cached" | "retrying" | "session"
>;
const session = (recovery?: ReturnType<typeof createRecovery>) =>
  ({ recovery }) as unknown as RelaySnapshot["session"];
const notices = () =>
  screen.queryAllByRole("dialog", {
    name: "Buzz is having trouble connecting",
  });

function mount(initial: Connection) {
  const view = render(
    <ToastProvider>
      <ConnectionNotice connection={initial} />
    </ToastProvider>,
  );
  return (next: Connection) =>
    view.rerender(
      <ToastProvider>
        <ConnectionNotice connection={next} />
      </ToastProvider>,
    );
}
const settle = () => act(() => vi.advanceTimersByTimeAsync(100));

it("classifies connection trouble: retrying failure and cached mode, not denials", () => {
  expect(connectionInTrouble({ status: "error", retrying: true })).toBe(true);
  expect(connectionInTrouble({ status: "connecting", cached: true })).toBe(
    true,
  );
  expect(connectionInTrouble({ status: "ready" })).toBe(false);
  expect(connectionInTrouble({ status: "connecting" })).toBe(false);
  // A failure nothing retries keeps its own surface; so does a settled cache.
  expect(connectionInTrouble({ status: "error" })).toBe(false);
  expect(connectionInTrouble({ status: "error", cached: true })).toBe(false);
});

it("shows the one notice after the quiet delay for a retrying failure, through its attempts, and clears when ready", async () => {
  vi.useFakeTimers();
  const update = mount({
    status: "error",
    retrying: true,
    session: session(),
  });
  await act(() => vi.advanceTimersByTimeAsync(RECOVERY_NOTICE_DELAY_MS - 1));
  expect(notices()).toHaveLength(0);
  // Each retry reads "connecting" between two failures; the delay keeps running.
  update({ status: "connecting", session: session() });
  await act(() => vi.advanceTimersByTimeAsync(1));
  await settle();
  const [notice] = notices();
  expect(notices()).toHaveLength(1);
  expect(notice).toHaveAccessibleDescription("Retrying automatically.");
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  update({ status: "error", retrying: true, session: session() });
  await settle();
  expect(notices()).toHaveLength(1);
  update({ status: "ready", session: session() });
  await settle();
  expect(notices()).toHaveLength(0);
});

it("covers cached/offline mode, where the session has no recovery", async () => {
  vi.useFakeTimers();
  const update = mount({
    status: "connecting",
    cached: true,
    session: session(),
  });
  await act(() => vi.advanceTimersByTimeAsync(RECOVERY_NOTICE_DELAY_MS));
  await settle();
  expect(notices()).toHaveLength(1);
  // The service replaces the cached session when the connection returns.
  update({ status: "ready", session: session(createRecovery([])) });
  await settle();
  expect(notices()).toHaveLength(0);
});

it("never shows twice when the connection and session recovery both report", async () => {
  vi.useFakeTimers();
  let failed = true;
  const listeners = new Set<() => void>();
  const source: RecoverySource = {
    status: () => (failed ? "failed" : "settled"),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry() {},
  };
  const recovery = createRecovery([source]);
  const update = mount({
    status: "error",
    retrying: true,
    session: session(recovery),
  });
  await act(() => vi.advanceTimersByTimeAsync(RECOVERY_NOTICE_DELAY_MS));
  await settle();
  expect(notices()).toHaveLength(1);
  // Connected again, but a read still fails: the same notice stays, once.
  update({ status: "ready", session: session(recovery) });
  await settle();
  expect(notices()).toHaveLength(1);
  failed = false;
  act(() => {
    for (const listener of [...listeners]) listener();
  });
  await settle();
  expect(notices()).toHaveLength(0);
  recovery.dispose();
});

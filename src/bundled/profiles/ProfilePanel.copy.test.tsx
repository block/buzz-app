// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { profileTarget } from "../../features/profiles/target";
import type { RelayData } from "../../features/relay/service";
import { createRelaySession } from "../../features/relay/session";
import { keypair, profile } from "../../features/relay/testing";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { ProfilePanel } from "./ProfilePanel";

const person = keypair();
const nip05 = "priya@example.org";
const publicProfile = profile(person, { name: "Priya", nip05 });
let dispose = () => {};

afterEach(() => {
  cleanup();
  dispose();
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "clipboard");
});

/** Each Copy button in the profile, with the text it must put on the clipboard. */
const fields = [
  ["Public key", "Copy npub", () => screen.getByText(/^npub1/).textContent],
  ["NIP-05", `Copy NIP-05: ${nip05}`, () => nip05],
] as const;

/** The mounted profile's Copy button, on a clock the test controls. */
async function copyButton(
  name: string,
  writeText: (text: string) => Promise<void>,
) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const owner = createRelaySession({
    viewer: keypair().pubkey,
    scope: "https://relay.example.test",
    relayAuthor: keypair().pubkey,
    query: async (filters) =>
      filters.some((filter) => filter.kinds?.includes(0))
        ? [publicProfile]
        : [],
    media: () => undefined,
  });
  dispose = owner.dispose;
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    session: owner.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    tryAgain() {},
    disconnect() {},
    clearCache: async () => {},
  };
  render(
    <ToastProvider>
      <ProfilePanel
        relay={relay}
        target={profileTarget(person.pubkey) ?? ""}
        close={() => {}}
      />
    </ToastProvider>,
  );
  // The NIP-05 card arrives with the profile read.
  await screen.findByText(nip05);
  vi.useFakeTimers();
  return screen.getByRole("button", { name });
}

/** A clipboard write the test finishes when it chooses. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The statuses that say something: one per result, none while idle. */
const announced = () =>
  screen
    .getAllByRole("status")
    .map((status) => status.textContent)
    .filter(Boolean);

it.each(fields)(
  "%s confirms a copy inside its button alone, then offers Copy again",
  async (_field, name, copied) => {
    const writeText = vi.fn(async (_text: string) => {});
    const button = await copyButton(name, writeText);
    expect(button).toHaveTextContent(/^Copy$/);
    expect(announced()).toEqual([]);

    await act(async () => fireEvent.click(button));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(copied());
    expect(button).toHaveTextContent(/^Copied$/);
    expect(button.querySelector(".tabler-icon-check")).not.toBeNull();
    expect(button).toHaveAccessibleName(name);
    expect(announced()).toEqual(["Copied"]);

    act(() => vi.advanceTimersByTime(1499));
    expect(button).toHaveTextContent(/^Copied$/);
    // The button and its status are the only feedback: no line and, now that
    // the clock a toast mounts on has run, no toast.
    expect(screen.getAllByText(/copied/i)).toHaveLength(2);
    expect(document.querySelector("[data-sonner-toast]")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(button).toHaveTextContent(/^Copy$/);
    expect(button.querySelector(".tabler-icon-copy")).not.toBeNull();
    expect(announced()).toEqual([]);
  },
);

it.each(fields)(
  "%s keeps a refused copy inside its button alone until the next attempt",
  async (_field, name) => {
    const retry = deferred();
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"))
      .mockReturnValueOnce(retry.promise);
    const button = await copyButton(name, writeText);
    try {
      await act(async () => fireEvent.click(button));
      expect(button).toHaveTextContent(/^Couldn’t copy$/);
      expect(button.querySelector(".tabler-icon-alert-circle")).not.toBeNull();
      expect(button).toHaveAccessibleName(name);
      expect(announced()).toEqual(["Couldn’t copy"]);

      // A copy reverts after 1.5 seconds. A refusal outlasts every timer now
      // pending, whatever its delay and whoever set it.
      act(() => vi.runOnlyPendingTimers());
      expect(button).toHaveTextContent(/^Couldn’t copy$/);
      expect(announced()).toEqual(["Couldn’t copy"]);
      // The other card's idle "Copy", then this button and its status.
      expect(screen.getAllByText(/copy|copied/i)).toHaveLength(3);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(document.querySelector("[data-sonner-toast]")).toBeNull();

      // The next attempt clears the refusal at once, then shows its own result.
      await act(async () => fireEvent.click(button));
      expect(writeText).toHaveBeenCalledTimes(2);
      expect(button).toHaveTextContent(/^Copy$/);
      expect(announced()).toEqual([]);
      await act(async () => retry.resolve());
      expect(button).toHaveTextContent(/^Copied$/);
      expect(announced()).toEqual(["Copied"]);
    } finally {
      retry.resolve();
    }
  },
);

it.each(fields)(
  "%s announces and times a second copy afresh while Copied still shows",
  async (_field, name) => {
    const second = deferred();
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(second.promise);
    const button = await copyButton(name, writeText);
    try {
      await act(async () => fireEvent.click(button));
      act(() => vi.advanceTimersByTime(1000));
      expect(button).toHaveTextContent(/^Copied$/);

      // The click empties the status, so the same words are announced again.
      await act(async () => fireEvent.click(button));
      expect(writeText).toHaveBeenCalledTimes(2);
      expect(button).toHaveTextContent(/^Copy$/);
      expect(announced()).toEqual([]);
      await act(async () => second.resolve());
      expect(button).toHaveTextContent(/^Copied$/);
      expect(announced()).toEqual(["Copied"]);

      // The 1.5 seconds run from the second result, not from the first.
      act(() => vi.advanceTimersByTime(1499));
      expect(button).toHaveTextContent(/^Copied$/);
      act(() => vi.advanceTimersByTime(1));
      expect(button).toHaveTextContent(/^Copy$/);
      expect(announced()).toEqual([]);
    } finally {
      second.resolve();
    }
  },
);

it.each(fields)(
  "%s drops its revert when the profile closes while Copied shows",
  async (_field, name) => {
    const button = await copyButton(
      name,
      vi.fn(async (_text: string) => {}),
    );
    await act(async () => fireEvent.click(button));
    expect(button).toHaveTextContent(/^Copied$/);
    expect(vi.getTimerCount()).toBe(1);

    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(fields)(
  "%s shows only its latest attempt's result",
  async (_field, name) => {
    const first = deferred();
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    const button = await copyButton(name, writeText);
    try {
      await act(async () => fireEvent.click(button));
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(button).toHaveTextContent(/^Copy$/);

      await act(async () => fireEvent.click(button));
      expect(writeText).toHaveBeenCalledTimes(2);
      expect(button).toHaveTextContent(/^Couldn’t copy$/);

      // The earlier write lands late; it must not replace the newer refusal.
      await act(async () => first.resolve());
      expect(button).toHaveTextContent(/^Couldn’t copy$/);
      expect(announced()).toEqual(["Couldn’t copy"]);
    } finally {
      first.resolve();
    }
  },
);

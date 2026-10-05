// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PairingSettings } from "./PairingSettings";
import type { ClientSnapshot } from "../../features/communities/service";
import type {
  PairingNative,
  PairingStatus,
} from "../../features/pairing/client";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it.each([true, false])(
  "renews a committed manual destination and pairs another phone (known viewer: %s)",
  async (knownViewer) => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    const viewer = "a".repeat(64);
    const snapshot: ClientSnapshot = {
      status: "ready",
      relayAvailable: true,
      ...(knownViewer ? { viewer } : {}),
      selected: null,
      profile: { name: "", picture: "" },
      memberships: [],
    };
    let status: PairingStatus = { phase: "idle" };
    const native = {
      account: vi.fn(async () => viewer),
      start: vi.fn<PairingNative["start"]>(async () => {
        status = { phase: "qr", svg: "<svg/>" };
      }),
      status: vi.fn(async () => status),
      cancel: vi.fn(async () => {}),
      confirm: vi.fn(async () => {}),
    } satisfies PairingNative;
    render(
      <PairingSettings
        communities={{ snapshot: () => snapshot, subscribe: () => () => {} }}
        active={() => true}
        available
        native={native}
      />,
    );
    if (!knownViewer)
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Use existing Buzz account" }),
        );
      });
    const input = screen.getByLabelText("Community address");
    fireEvent.change(input, { target: { value: "https://community.example" } });
    expect(native.start).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.blur(input);
    });
    expect(native.start).toHaveBeenCalledTimes(1);
    status = { phase: "expired" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(native.start).toHaveBeenCalledTimes(2);
    expect(native.start.mock.calls[1]).toEqual([
      expect.any(String),
      viewer,
      "https://community.example",
    ]);
    status = { phase: "complete" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Pair another phone" }),
      );
    });
    expect(native.start).toHaveBeenCalledTimes(3);
    expect(native.start.mock.calls[2]).toEqual([
      expect.any(String),
      viewer,
      "https://community.example",
    ]);
  },
);

it("keeps an unacknowledged transfer visible until a deliberate new attempt", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const viewer = "a".repeat(64);
  const snapshot: ClientSnapshot = {
    status: "ready",
    relayAvailable: true,
    viewer,
    selected: "https://community.example",
    profile: { name: "", picture: "" },
    memberships: [],
  };
  let status: PairingStatus = { phase: "idle" };
  const native = {
    account: vi.fn(async () => viewer),
    start: vi.fn<PairingNative["start"]>(async () => {
      status = { phase: "qr", svg: "<svg/>" };
    }),
    status: vi.fn(async () => status),
    cancel: vi.fn(async () => {}),
    confirm: vi.fn(async () => {}),
  } satisfies PairingNative;
  await act(async () => {
    render(
      <PairingSettings
        communities={{ snapshot: () => snapshot, subscribe: () => () => {} }}
        active={() => true}
        available
        native={native}
      />,
    );
  });
  expect(native.start).toHaveBeenCalledTimes(1);
  status = { phase: "transferring" };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  status = { phase: "uncertain" };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(
    screen.getByRole("heading", { name: "Check your phone" }),
  ).toBeTruthy();
  expect(
    screen.queryByAltText("Scan this QR code with Buzz on your phone"),
  ).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(240000);
  });
  expect(native.start).toHaveBeenCalledTimes(1);
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Start a new pairing" }),
    );
  });
  expect(native.start).toHaveBeenCalledTimes(2);
});

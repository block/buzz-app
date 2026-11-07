// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ChannelReference,
  ChannelList,
  ChannelMessage,
} from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { Navigation } from "../navigation/controller";
import { keypair, signed } from "../relay/testing";
import {
  controlTemplate,
  moveControl,
  moveState,
  type MoveRequest,
} from "./protocol";
import * as coordinator from "./coordinator";
import { DmMoveCard } from "./DmMove";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function fixture(initial: ChannelReference = { state: "unknown" }) {
  const alice = keypair(),
    bob = keypair();
  const now = Math.floor(Date.now() / 1000);
  const request: MoveRequest = {
    type: "request",
    move: "e44c7b53-42b2-4c5e-8051-fce508998b96",
    worker: "e44c7b53-42b2-4c5e-8051-fce508998b97",
    target: "target",
    expires: now + 86400,
    authors: [
      [alice.pubkey, alice.pubkey],
      [bob.pubkey, bob.pubkey],
    ],
  };
  const event = signed(alice, {
    ...controlTemplate("dm", request),
    created_at: now,
  });
  const record = moveControl(event);
  if (!record) throw new Error("Invalid request fixture");
  const snapshot: coordinator.MoveSnapshot = {
    loading: false,
    moves: [moveState({ ...record, control: request }, [record], now)],
  };
  const respond = vi.fn(async () => {});
  vi.spyOn(coordinator, "dmMoves").mockReturnValue({
    snapshot: () => snapshot,
    subscribe: () => () => {},
    respond,
  } as unknown as coordinator.DmMoves);
  let reference = initial;
  const listeners = new Set<() => void>();
  const release = vi.fn();
  const refer = vi.fn(() => release);
  const list: ChannelList = { status: "ready", channels: [] };
  const session = {
    viewer: bob.pubkey,
    channels: {
      list: () => list,
      get: () => undefined,
      describe: () => reference,
      refer,
      subscribeList: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    profiles: { snapshot: () => new Map([[alice.pubkey, { name: "Alice" }]]) },
  } as unknown as RelaySession;
  render(
    <DmMoveCard
      session={session}
      message={{ dmMove: event.id } as ChannelMessage}
      navigation={{} as Navigation}
    />,
  );
  return {
    event,
    respond,
    refer,
    release,
    answer(next: ChannelReference) {
      act(() => {
        reference = next;
        for (const listener of listeners) listener();
      });
    },
  };
}

it("names an unjoined public destination before allowing approval", () => {
  const f = fixture();
  expect(f.refer).toHaveBeenCalledWith("target");
  expect(screen.getByText("Loading destination…")).toBeVisible();
  expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  f.answer({
    state: "found",
    name: "launch-planning",
    description: "",
    channelType: "stream",
    private: false,
    hidden: false,
    archived: false,
    joined: false,
  });
  expect(
    screen.getByRole("region", { name: "Convert DM to #launch-planning" }),
  ).toBeVisible();
  const approve = screen.getByRole("button", { name: "Approve" });
  expect(approve).toBeEnabled();
  fireEvent.click(approve);
  expect(f.respond).toHaveBeenCalledWith(f.event.id, true);
});

it("keeps an unavailable destination unapprovable while allowing a decline", () => {
  fixture({ state: "withheld" });
  expect(
    screen.getByText("The destination channel is unavailable."),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Decline" })).toBeEnabled();
});

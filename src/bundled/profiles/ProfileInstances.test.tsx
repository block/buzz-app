// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  AgentControl,
  AgentControlState,
} from "../../features/agents/control";
import type { Navigation } from "../../features/navigation/controller";
import { ProfileInstances } from "./ProfileInstances";

const person = "a".repeat(64);
const viewer = "b".repeat(64);
const instance = (id: string, pubkey: string, relayUrl: string) => ({
  id,
  pubkey,
  relayUrl,
  name: id,
  status: "stopped" as const,
});
function fixture() {
  let state: AgentControlState = {
    status: "idle",
    data: null,
    busy: false,
    error: null,
  };
  const listeners = new Set<() => void>();
  const refresh = vi.fn(async () => {});
  const control = {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
  } as unknown as AgentControl;
  const open = vi.fn(async () => ({ status: "opened" as const }));
  const navigation = { open } as unknown as Navigation;
  const update = (next: AgentControlState) =>
    act(() => {
      state = next;
      for (const listener of listeners) listener();
    });
  return { control, navigation, open, update, refresh };
}
afterEach(cleanup);

it("uses native exact identity and community, never library display links", () => {
  const f = fixture();
  render(
    <ProfileInstances
      control={f.control}
      navigation={f.navigation}
      pubkey={person}
      viewer={viewer}
      scope={`https://relay.example.test:${viewer}`}
      communityOrigin="https://relay.example.test"
      knownAgent={true}
    />,
  );
  expect(f.refresh).toHaveBeenCalledOnce();
  expect(screen.getByRole("status").textContent).toContain(
    "Loading managed agents",
  );
  f.update({
    status: "ready",
    data: {
      agents: [
        instance("matched", person, "wss://relay.example.test"),
        instance("wrong-key", viewer, "wss://relay.example.test"),
        instance("wrong-relay", person, "wss://other.example.test"),
      ] as NonNullable<AgentControlState["data"]>["agents"],
      runtimeAvailable: true,
    },
    busy: false,
    error: null,
  });
  expect(screen.getByText("matched")).toBeTruthy();
  expect(screen.queryByText(/wrong-key|wrong-relay|stopped/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "View in Agents" }));
  expect(f.open).toHaveBeenCalledWith({
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope: { viewer, communityOrigin: "https://relay.example.test" },
  });
  f.update({ status: "unavailable", data: null, busy: false, error: null });
  expect(
    screen.queryByRole("region", { name: "Linked agent instances" }),
  ).toBeNull();
});

it("omits instances without a valid community", () => {
  const f = fixture();
  f.update({ status: "error", data: null, busy: false, error: "failed" });
  render(
    <ProfileInstances
      control={f.control}
      navigation={f.navigation}
      pubkey={person}
      viewer={viewer}
      scope="unknown"
      communityOrigin={undefined}
      knownAgent={true}
    />,
  );
  expect(
    screen.queryByRole("region", { name: "Linked agent instances" }),
  ).toBeNull();
  expect(f.refresh).not.toHaveBeenCalled();
  expect(f.open).not.toHaveBeenCalled();
});

it("retries failed native discovery in a valid community without presenting stale instances", () => {
  const f = fixture();
  f.update({ status: "error", data: null, busy: false, error: "failed" });
  render(
    <ProfileInstances
      control={f.control}
      navigation={f.navigation}
      pubkey={person}
      viewer={viewer}
      scope={`https://relay.example.test:${viewer}`}
      communityOrigin="https://relay.example.test"
      knownAgent={true}
    />,
  );
  expect(screen.getByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry agents" }));
  expect(f.refresh).toHaveBeenCalledOnce();
  expect(f.open).not.toHaveBeenCalled();
});

it("does not refresh or display instances for a human without a native match", () => {
  const f = fixture();
  const { rerender } = render(
    <ProfileInstances
      control={f.control}
      navigation={f.navigation}
      pubkey={person}
      viewer={viewer}
      scope={`https://relay.example.test:${viewer}`}
      communityOrigin="https://relay.example.test"
      knownAgent={false}
    />,
  );
  expect(f.refresh).not.toHaveBeenCalled();
  f.update({
    status: "ready",
    data: {
      agents: [
        instance("someone-else", viewer, "wss://relay.example.test"),
      ] as NonNullable<AgentControlState["data"]>["agents"],
      runtimeAvailable: true,
    },
    busy: false,
    error: null,
  });
  rerender(
    <ProfileInstances
      control={f.control}
      navigation={f.navigation}
      pubkey={person}
      viewer={viewer}
      scope={`https://relay.example.test:${viewer}`}
      communityOrigin="https://relay.example.test"
      knownAgent={false}
    />,
  );
  expect(
    screen.queryByRole("region", { name: "Linked agent instances" }),
  ).toBeNull();
});

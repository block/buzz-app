import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { ComposerAccessoryProps, ComposerAccessory } from "./contracts";
import type { Contribution } from "../../plugins/contributions";
import { ComposerAccessories } from "./ComposerAccessories";
import type { RelaySession } from "../relay/session";

// Invoke actual contribution command wrappers with controlled layout lifetimes.
// Browser coverage owns DOM focus, tooltip interaction and panel placement.
const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  index: 0,
  state: undefined as unknown,
  effects: [] as (() => undefined | (() => void))[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
    snapshot(),
  useRef: (value: unknown) => {
    const index = hooks.index++;
    hooks.refs[index] ??= { current: value };
    return hooks.refs[index];
  },
  useLayoutEffect: (effect: () => undefined | (() => void)) =>
    hooks.effects.push(effect),
  useState: () => [
    hooks.state,
    (next: unknown) => {
      hooks.state = next;
    },
  ],
}));
beforeEach(() => {
  hooks.refs = [];
  hooks.index = 0;
  hooks.state = undefined;
  hooks.effects = [];
});
it("revokes navigation after contribution removal, replacement and composer unmount", () => {
  const entry: Contribution<ComposerAccessory> = {
    id: "activity",
    key: "test:activity",
    pluginId: "test",
    revision: "one",
    title: "Activity",
    component: () => null,
  };
  let entries = [entry];
  const registry = { snapshot: () => entries, subscribe: () => () => {} };
  const open = vi.fn(() => true);
  const canOpen = vi.fn(() => true);
  const props = {
    registry,
    session: {} as RelaySession,
    scope: "scope",
    channelId: "channel",
    open,
    canOpen,
  };
  const boundaries = ComposerAccessories(props);
  const owned = boundaries[0]?.props.children as ReactElement;
  const render = () => {
    hooks.index = 0;
    return (
      owned.type as (props: unknown) => ReactElement<ComposerAccessoryProps>
    )(owned.props);
  };
  render();
  const cleanups = hooks.effects.splice(0).map((effect) => effect());
  const commands = render().props;
  expect(commands.open("target")).toBe(true);
  entries = [];
  expect(commands.open("target")).toBe(false);
  expect(commands.canOpen("target")).toBe(false);
  entries = [{ ...entry }];
  expect(commands.open("target")).toBe(false);
  entries = [entry];
  for (const cleanup of cleanups) cleanup?.();
  expect(commands.open("target")).toBe(false);
  expect(commands.canOpen("target")).toBe(false);
  expect(open).toHaveBeenCalledTimes(1);
});

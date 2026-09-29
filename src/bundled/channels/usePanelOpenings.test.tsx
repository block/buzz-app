// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { activityTarget } from "../../features/agents/activity-target";
import {
  profileActivityViewTarget,
  profileTarget,
} from "../../features/profiles/target";
import type { RegisteredPanel } from "../../features/panels/service";
import { openingTab, usePanelOpenings } from "./usePanelOpenings";

const panel: RegisteredPanel = {
  id: "activity",
  key: "test/activity",
  pluginId: "test",
  revision: "1",
  title: "Activity",
  matches: () => true,
  component: () => null,
};
const carl = "a".repeat(64),
  vogue = "b".repeat(64);
const entry = (agent = carl, channelId = "alpha") => ({
  panel,
  channelId,
  target: activityTarget(agent, channelId),
});
afterEach(cleanup);

it("retains multiple agents, selects an existing tab and preserves its opening", () => {
  const { result } = renderHook(usePanelOpenings);
  const a = entry(),
    b = entry(vogue);
  act(() => {
    result.current.open(a);
    result.current.open(b);
  });
  expect(result.current.openings).toEqual([a, b]);
  expect(result.current.selected).toBe(openingTab(b));
  act(() => result.current.open({ ...a }));
  expect(result.current.openings).toEqual([a, b]);
  expect(result.current.openings[0]).toBe(a);
  expect(result.current.selected).toBe(openingTab(a));
});

it("retargets the same agent without broadening an exact response or duplicating its tab", () => {
  const { result } = renderHook(usePanelOpenings);
  const a = entry(),
    b = entry(vogue);
  act(() => {
    result.current.open(a);
    result.current.open(b);
  });
  const exact = { ...a, target: activityTarget(carl, "alpha", "c".repeat(64)) };
  act(() => {
    result.current.open(exact);
    expect(result.current.current.current).not.toContain(a);
    expect(result.current.current.current).toContain(b);
  });
  expect(result.current.openings).toEqual([exact, b]);
  expect(result.current.selected).toBe(openingTab(a));
  const profile = { ...a, target: profileActivityViewTarget(carl) ?? "" };
  act(() => result.current.open(profile));
  expect(result.current.openings).toEqual([profile, b]);
});

it("closes independently, ignores retired closes, and falls back to a neighbor then Thread", () => {
  const { result } = renderHook(usePanelOpenings);
  const a = entry(),
    b = entry(vogue);
  act(() => {
    result.current.open(a);
    result.current.open(b);
  });
  act(() => result.current.remove(a));
  expect(result.current.openings).toEqual([b]);
  expect(result.current.selected).toBe(openingTab(b));
  act(() => result.current.open(a));
  act(() => result.current.remove(a));
  expect(result.current.selected).toBe(openingTab(b));
  act(() => result.current.remove(b));
  expect(result.current.selected).toBe("thread");
  const replacement = { ...a };
  act(() => result.current.open(replacement));
  act(() => result.current.remove(a));
  expect(result.current.openings).toEqual([replacement]);
  act(() => result.current.select("thread"));
  act(() => result.current.remove(replacement));
  expect(result.current.selected).toBe("thread");
});

it("replaces ordinary panels and resets every captured opening synchronously", () => {
  const { result } = renderHook(usePanelOpenings);
  const a = entry(),
    b = entry(vogue),
    regular = { ...a, target: "https://example.com" };
  act(() => {
    result.current.open(a);
    result.current.open(b);
  });
  act(() => result.current.open(regular));
  expect(result.current.openings).toEqual([regular]);
  expect(result.current.selected).toBe("target");
  act(() => result.current.open(a));
  expect(result.current.openings).toEqual([a]);
  act(() => result.current.open(entry(vogue, "beta")));
  expect(result.current.openings).toEqual([entry(vogue, "beta")]);
  act(() => {
    result.current.open(undefined);
    expect(result.current.current.current).toEqual([]);
  });
  expect(result.current.openings).toEqual([]);
  expect(result.current.selected).toBe("thread");
});

it("replaces a plugin registration without reviving callbacks from its previous revision", () => {
  const { result } = renderHook(usePanelOpenings);
  const a = entry();
  act(() => result.current.open(a));
  const replacement = { ...a, panel: { ...panel, revision: "2" } };
  act(() => result.current.open(replacement));
  expect(result.current.openings).toEqual([replacement]);
  expect(result.current.current.current).not.toContain(a);
});

it("uses the same identity tab for profile Info and activity without rewriting either target", () => {
  const { result } = renderHook(usePanelOpenings);
  const a = entry(),
    b = entry(vogue);
  act(() => {
    result.current.open(a);
    result.current.open(b);
  });
  const info = { ...a, target: profileTarget(carl) ?? "" };
  act(() => result.current.open(info));
  expect(result.current.openings).toEqual([info, b]);
  expect(result.current.selected).toBe(openingTab(a));
  act(() => result.current.open(a));
  expect(result.current.openings).toEqual([a, b]);
});

it("selects a different same-channel thread without losing identity tabs or revoking their openings", () => {
  const { result } = renderHook(usePanelOpenings);
  const a = entry(),
    b = entry(vogue);
  act(() => {
    result.current.open(a);
    result.current.open(b);
  });
  act(() => result.current.showThread("alpha"));
  expect(result.current.openings).toEqual([a, b]);
  expect(result.current.current.current[0]).toBe(a);
  expect(result.current.selected).toBe("thread");
  act(() => result.current.showThread("beta"));
  expect(result.current.openings).toEqual([]);
  act(() => result.current.open({ ...a, target: "https://example.com" }));
  act(() => result.current.showThread("alpha"));
  expect(result.current.openings).toEqual([]);
});

// biome-ignore-all lint/style/noNonNullAssertion: Fixtures deliberately require their arranged calls, elements and results to exist.
// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { card, type ProviderStatus } from "./card.tsx";
import { KEY, load } from "./settings.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function provider(initial: ReturnType<ProviderStatus["status"]>) {
  let status = initial;
  const listeners = new Set<() => void>();
  return {
    status: () => status,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    set(next: ReturnType<ProviderStatus["status"]>) {
      status = next;
      listeners.forEach((l) => {
        l();
      });
    },
  };
}

function mount(active = () => true, decisions = provider("ready")) {
  const Card = card(React, decisions);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<Card active={active} />));
  const toggle = (name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(
      (b) => b.labels?.[0]?.textContent === name,
    )!;
  const click = (name: string) => act(() => toggle(name).click());
  return {
    host,
    toggle,
    click,
    decisions,
    unmount: () => act(() => root.unmount()),
  };
}

afterEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
});

describe("settings", () => {
  it("default to this channel, memories only with the owner", () => {
    expect(load()).toEqual({ scope: "channel", sharedMemories: false });
  });
  it.each([
    ["garbage", "{"],
    ["wrong types", '{"scope":"everywhere","sharedMemories":"yes"}'],
    ["not an object", "7"],
  ])("fall back to the narrowest choice on %s", (_, saved) => {
    localStorage.setItem(KEY, saved);
    expect(load()).toEqual({ scope: "channel", sharedMemories: false });
  });
});

describe("the card", () => {
  it("shows the saved choices and saves each change", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ scope: "relay", sharedMemories: false }),
    );
    const { toggle, click } = mount();
    expect(toggle("Search the whole relay").getAttribute("aria-checked")).toBe(
      "true",
    );
    click("Search the whole relay");
    click("Recall memories in channels other people can read");
    expect(load()).toEqual({ scope: "channel", sharedMemories: true });
    expect(toggle("Search the whole relay").getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("writes nothing once its plugin is no longer active", () => {
    const { click } = mount(() => false);
    click("Search the whole relay");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("says when recall cannot ask a Decisions provider, and follows its status", () => {
    const { host, decisions } = mount(undefined, provider("needs-setup"));
    const status = () => host.querySelector('[role="status"]')!.textContent;
    expect(status()).toMatch(/shows nothing until/);
    act(() => decisions.set("ready"));
    expect(status()).toMatch(/is ready/);
  });
});

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createRef } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppServices } from "../services";
import { SearchChoices, type SearchGroup } from "./SearchChoices";
import { useSearchSettings } from "./SearchSettings";
import { GearIcon } from "../../shared/design-system/icons";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

function fixture() {
  const state = {
    preferences: { enabled: true, sound: true, notifyWhileViewing: false },
    developmentPaused: false,
  };
  const updatePreferences = vi.fn();
  const notifications = {
    subscribe: () => () => {},
    snapshot: () => state,
    updatePreferences,
  } as unknown as AppServices["notifications"];
  const open = vi.fn().mockResolvedValue({ status: "opened" });
  const navigation = { open } as unknown as AppServices["navigation"];
  const close = vi.fn();
  function Palette({ groups = [] }: { groups?: SearchGroup[] }) {
    const inlineSettings = useSearchSettings({
      query: "sound",
      notifications,
      navigation,
      close,
    });
    return (
      <SearchChoices
        query="sound"
        onQueryChange={() => {}}
        input={createRef()}
        groups={groups}
        inlineSettings={inlineSettings}
      />
    );
  }
  return { Palette, open, close, updatePreferences };
}

it("changes the trailing switch inline but opens and highlights the setting from its row", async () => {
  const { Palette, open, close, updatePreferences } = fixture();
  const target = document.createElement("div");
  target.id = "setting-sound";
  target.className = "buzz-preference-row";
  document.body.append(target);
  try {
    render(<Palette />);
    fireEvent.click(screen.getByRole("switch", { name: "Sound" }));
    expect(updatePreferences).toHaveBeenCalledWith({ sound: false });
    expect(open).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Sound"));
    expect(open).toHaveBeenCalledWith({
      version: 1,
      kind: "settings",
      section: "notifications",
    });
    expect(close).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(target).toHaveClass("settings-search-highlight"),
    );
    fireEvent.animationEnd(target);
    expect(target).not.toHaveClass("settings-search-highlight");
  } finally {
    target.remove();
  }
});

it("retains inline matches and keyboard selection when conversation results arrive", () => {
  const { Palette, open } = fixture();
  const { rerender } = render(<Palette />);
  const input = screen.getByRole("combobox", { name: "Search Buzz" });
  const selected = input.getAttribute("aria-activedescendant");
  rerender(
    <Palette
      groups={[
        {
          label: "Conversations",
          destinations: [
            { key: "sound-chat", label: "Sound", icon: GearIcon, run: vi.fn() },
          ],
        },
      ]}
    />,
  );
  expect(screen.getByRole("switch", { name: "Sound" })).toBeVisible();
  expect(input).toHaveAttribute("aria-activedescendant", selected);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(open).toHaveBeenCalledWith({
    version: 1,
    kind: "settings",
    section: "notifications",
  });
});

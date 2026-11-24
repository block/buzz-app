// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsSearchNavigation } from "./SettingsSearchNavigation";
import {
  searchSettings,
  settingSearchEntries,
  revealSetting,
} from "./settings-search";
import type { SettingsGroup } from "./settings-sections";
import { createShortcutBindings } from "../features/shortcuts/preferences";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { SwitchPreferenceRow } from "../shared/design-system/ui/SwitchPreferenceRow";

const groups: SettingsGroup[] = [
  {
    id: "app",
    label: "Buzz",
    sections: [
      { id: "appearance", label: "Appearance" },
      { id: "notifications", label: "Notifications" },
      { id: "example/calendar", label: "Calendar" },
    ],
  },
];
beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it("matches individual labels, synonyms, mixed-case words and visible plugin destinations", () => {
  expect(
    searchSettings(groups, "  FONT   size ").map((row) => row.setting?.label),
  ).toEqual(["Interface size"]);
  expect(
    searchSettings(groups, "appearance thread").map(
      (row) => row.setting?.label,
    ),
  ).toEqual(["Open threads in"]);
  expect(searchSettings(groups, "calendar")).toEqual([
    { section: "example/calendar", label: "Calendar" },
  ]);
  expect(searchSettings(groups, "log level")).toEqual([]);
  expect(searchSettings(groups, " ")).toEqual([]);
  expect(new Set(settingSearchEntries.map((row) => row.id)).size).toBe(
    settingSearchEntries.length,
  );
});

it("opens a matching setting by keyboard, clears empty results, and clears Escape without dismissing its host", async () => {
  const user = userEvent.setup();
  const onSetting = vi.fn();
  const onSection = vi.fn();
  const hostKeyDown = vi.fn();
  const view = render(
    <div
      role="dialog"
      aria-label="Settings"
      tabIndex={-1}
      onKeyDown={hostKeyDown}
    >
      <SettingsSearchNavigation
        groups={groups}
        onSetting={onSetting}
        onSection={onSection}
      >
        <button type="button">Normal navigation</button>
      </SettingsSearchNavigation>
    </div>,
  );
  const search = screen.getByRole("searchbox", { name: "Search settings" });
  await user.type(search, "thread");
  expect(
    screen.queryByRole("button", { name: "Normal navigation" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("1 result");
  await user.tab(); // Clear search
  await user.tab(); // Result
  await user.keyboard("{Enter}");
  expect(onSetting).toHaveBeenCalledWith(
    expect.objectContaining({ id: "setting-threads", section: "appearance" }),
  );
  expect(onSection).not.toHaveBeenCalled();
  await user.clear(search);
  await user.type(search, "nothing matches this");
  expect(screen.getByRole("status")).toHaveTextContent("No settings found");
  await user.click(
    screen.getByRole("button", { name: "Clear search settings" }),
  );
  expect(search).toHaveFocus();
  expect(
    screen.getByRole("button", { name: "Normal navigation" }),
  ).toBeInTheDocument();
  await user.type(search, "calendar");
  await user.click(screen.getByRole("button", { name: "Open Calendar" }));
  expect(onSection).toHaveBeenCalledWith("example/calendar");
  search.focus();
  hostKeyDown.mockClear();
  await user.keyboard("{Escape}");
  expect(search).toHaveValue("");
  expect(hostKeyDown).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  expect(hostKeyDown).toHaveBeenCalledOnce();
  // Reactive visibility changes remove results even while the query is kept.
  await user.type(search, "calendar");
  view.rerender(
    <div
      role="dialog"
      aria-label="Settings"
      tabIndex={-1}
      onKeyDown={hostKeyDown}
    >
      <SettingsSearchNavigation
        groups={[]}
        onSetting={onSetting}
        onSection={onSection}
      >
        No sections
      </SettingsSearchNavigation>
    </div>,
  );
  expect(search).toHaveValue("calendar");
  expect(
    screen.queryByRole("button", { name: "Open Calendar" }),
  ).not.toBeInTheDocument();
});

it("focuses the search with the conversation search chord, following its rebind", async () => {
  const user = userEvent.setup();
  localStorage.clear();
  const bindings = createShortcutBindings();
  render(
    <div role="dialog" aria-modal="true" aria-label="Settings">
      <SettingsSearchNavigation
        groups={groups}
        onSetting={vi.fn()}
        onSection={vi.fn()}
        shortcutBindings={bindings}
      >
        <button type="button">Normal navigation</button>
      </SettingsSearchNavigation>
    </div>,
  );
  const search = screen.getByRole("searchbox", { name: "Search settings" });
  await user.type(search, "sound");
  screen.getByRole("button", { name: /^Sound/ }).focus();
  // jsdom reports a non-Apple platform, so the default chord is Ctrl+F.
  await user.keyboard("{Control>}f{/Control}");
  expect(search).toHaveFocus();
  expect([
    (search as HTMLInputElement).selectionStart,
    (search as HTMLInputElement).selectionEnd,
  ]).toEqual([0, "sound".length]);

  act(() => bindings.set("conversation-search", { key: "g", mod: true }));
  screen.getByRole("button", { name: /^Sound/ }).focus();
  await user.keyboard("{Control>}f{/Control}");
  expect(search).not.toHaveFocus();
  await user.keyboard("{Control>}g{/Control}");
  expect(search).toHaveFocus();
  bindings.dispose();
  localStorage.clear();
});

it("reveals a switch without toggling it, and falls back to a prerequisite without changing it", () => {
  const scroll = vi.fn();
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(scroll);
  const change = vi.fn();
  render(
    <>
      <SwitchPreferenceRow
        id="setting-sound"
        label="Sound"
        checked
        onCheckedChange={change}
      />
      <SwitchPreferenceRow
        id="setting-desktop-alerts"
        label="Desktop alerts"
        checked={false}
        onCheckedChange={change}
      />
    </>,
  );
  const entry = settingSearchEntries.find((row) => row.id === "setting-sound");
  if (!entry) throw new Error("Missing Sound search entry");
  revealSetting(entry);
  expect(screen.getByRole("switch", { name: "Sound" })).toHaveFocus();
  expect(scroll).toHaveBeenCalledWith({ block: "center", behavior: "instant" });
  screen
    .getByRole("switch", { name: "Sound" })
    .closest(".buzz-preference-row")
    ?.setAttribute("hidden", "");
  revealSetting(entry);
  expect(screen.getByRole("switch", { name: "Desktop alerts" })).toHaveFocus();
  expect(change).not.toHaveBeenCalled();
});

it("does not focus hidden, inert or disabled controls, including fallback content", () => {
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
    () => {},
  );
  const view = render(
    <div id="settings-content" tabIndex={-1}>
      <div hidden>
        <input aria-label="Hidden" />
      </div>
      <PreferenceRow
        id="setting-mode"
        title="Mode"
        trailing={
          <button type="button" disabled>
            Unavailable
          </button>
        }
      />
    </div>,
  );
  const entry = settingSearchEntries.find((row) => row.id === "setting-mode");
  if (!entry) throw new Error("Missing Mode search entry");
  revealSetting(entry);
  expect(document.getElementById("setting-mode")).toHaveFocus();
  view.rerender(
    <div id="settings-content" tabIndex={-1}>
      <div inert>
        <div id="setting-mode">
          <button type="button">Retired</button>
        </div>
      </div>
    </div>,
  );
  revealSetting(entry);
  expect(document.getElementById("settings-content")).toHaveFocus();
});

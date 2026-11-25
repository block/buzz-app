// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { PluginRuntime } from "../../plugins/runtime";
import { provideNavigation } from "../navigation/service";
import { NotificationsService } from "./service";
import { conversationSoundKey } from "./preferences";
import { ConversationSoundSettings } from "./ConversationSoundSettings";

const contexts: Context[] = [];
afterEach(async () => {
  cleanup();
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  vi.restoreAllMocks();
  localStorage.clear();
});

it("selects and restores a personal conversation sound without changing alerts or another conversation", async () => {
  const ctx = new Context();
  contexts.push(ctx);
  const runtime = new PluginRuntime(ctx, async () => ({ apply() {} }));
  ctx.effect(() => () => runtime.dispose());
  const service = new NotificationsService(
    ctx,
    provideNavigation(ctx).navigation,
    {
      label: "Test",
      permission: async () => "granted",
      requestPermission: async () => "granted",
      show: async () => {},
      dispose() {},
    },
  );
  const scope = {
    viewer: "a".repeat(64),
    communityOrigin: "https://relay.example.com",
  };
  service.selectViewer(scope.viewer);
  // Choices remain editable while global sound is off, without playing a preview.
  service.updatePreferences({ sound: false });
  const categories = service.snapshot().preferences.categories;
  const user = userEvent.setup();
  const component = (channelId: string) => (
    <ConversationSoundSettings
      notifications={service}
      scope={scope}
      channelId={channelId}
    />
  );
  const view = render(component("dm"));
  const picker = () =>
    screen.getByRole("combobox", { name: "Notification sound" });
  async function choose(label: string) {
    await user.click(picker());
    await user.click(await screen.findByRole("option", { name: label }));
  }
  expect(picker()).toHaveTextContent("Use default");
  await choose("ping");
  act(() => service.reloadPreferences());
  expect(picker()).toHaveTextContent("ping");
  expect(
    service.snapshot().preferences.conversationSounds[
      conversationSoundKey(scope.communityOrigin, "dm")
    ],
  ).toBe("ping");
  view.rerender(component("channel"));
  expect(picker()).toHaveTextContent("Use default");
  await choose("Silent");
  view.rerender(component("dm"));
  expect(picker()).toHaveTextContent("ping");
  await choose("Use default");
  expect(service.snapshot().preferences.conversationSounds).toEqual({
    [conversationSoundKey(scope.communityOrigin, "channel")]: "silent",
  });
  expect(service.snapshot().preferences.categories).toEqual(categories);
  expect(service.snapshot().preferences.sound).toBe(false);
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("disk");
    });
  await choose("boo");
  expect(screen.getByRole("alert")).toBeVisible();
  expect(picker()).toHaveTextContent("boo");
  write.mockRestore();
  await user.click(screen.getByRole("button", { name: "Retry saving" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  act(() => service.reloadPreferences());
  expect(picker()).toHaveTextContent("boo");
  act(() => service.selectViewer("b".repeat(64)));
  expect(picker()).toBeDisabled();
});

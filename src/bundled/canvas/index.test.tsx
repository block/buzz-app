// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { Panels, RegisteredPanel } from "../../features/panels/service";
import { keypair, signed } from "../../features/relay/testing";
import { useChannelPanels } from "../channels/useChannelPanels";
import { apply } from ".";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  cleanup();
  localStorage.clear();
  for (const dispose of disposals.splice(0)) await dispose();
});

// Exercise the real plugin's launcher and editor through the page's actual panel
// owner: moving from a dialog to this host must not lose drafts or focus.
it("restores a closed draft, isolates channels, and saves through the canvas capability", async () => {
  const user = userEvent.setup();
  const ctx = new Context();
  disposals.push(async () => {
    await ctx.fiber.dispose();
  });
  const key = keypair();
  const head = signed(key, {
    kind: 40100,
    content: "Saved",
    tags: [["h", "alpha"]],
  });
  const canvas = {
    available: true,
    history: vi.fn(async () => ({ revisions: [head], next: undefined })),
    read: vi.fn(async () => head),
    save: vi.fn(async (_id: string, content: string) => ({
      ...head,
      content,
      id: "b".repeat(64),
    })),
  };
  const owned = createRelaySession(null);
  disposals.push(async () => owned.dispose());
  const state = {
    status: "ready" as const,
    generation: 1,
    scope: "sandbox:viewer",
    viewer: key.pubkey,
    session: { ...owned.session, canvas },
  };
  const available: RegisteredPanel[] = [];
  const panels: Panels = {
    snapshot: () => available,
    subscribe: () => () => {},
    resolve: () => undefined,
    register: (panel) => {
      available.push({
        ...panel,
        key: `buzz.canvas/${panel.id}`,
        pluginId: "buzz.canvas",
        revision: "test",
      });
    },
  };
  ctx.provide("panels", panels);
  ctx.provide("relay", {
    snapshot: () => state,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    async clearCache() {},
  });
  await apply(ctx);
  const contexts = ["alpha", "beta"].map((channelId) => ({
    scope: state.scope,
    viewer: key.pubkey,
    channelId,
    channelName: channelId,
    relayUrl: "",
  }));
  function Harness() {
    const [channel, setChannel] = useState(0);
    const drawer = useChannelPanels(panels, contexts[channel]);
    return (
      <>
        <button type="button" onClick={() => setChannel(1 - channel)}>
          Switch channel
        </button>
        {drawer.launchers}
        {drawer.side}
        {drawer.content}
      </>
    );
  }
  render(<Harness />);
  const launcher = () =>
    screen.getByRole("button", { name: "Toggle channel canvas" });
  await user.click(launcher());
  const text = () => screen.getByRole("textbox", { name: "Canvas Markdown" });
  await waitFor(() => expect(text()).toHaveValue("Saved"));
  expect(text()).toHaveFocus();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.change(text(), { target: { value: "Alpha draft" } });
  await user.click(screen.getByRole("button", { name: "Close Canvas" }));
  expect(launcher()).toHaveFocus();
  expect(canvas.save).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(text()).toHaveValue("Alpha draft"));
  await user.click(screen.getByRole("button", { name: "Switch channel" }));
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  await user.click(launcher());
  await waitFor(() => expect(text()).toHaveValue("Saved"));
  fireEvent.change(text(), { target: { value: "Beta draft" } });
  await user.click(screen.getByRole("button", { name: "Switch channel" }));
  await user.click(launcher());
  await waitFor(() => expect(text()).toHaveValue("Alpha draft"));
  canvas.save.mockRejectedValueOnce(new Error("Offline: draft kept"));
  await user.click(screen.getByRole("button", { name: "Save Canvas" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Offline: draft kept",
  );
  expect(text()).toHaveValue("Alpha draft");
  await user.click(screen.getByRole("button", { name: "Save Canvas" }));
  await waitFor(() => expect(launcher()).toHaveFocus());
  expect(canvas.save).toHaveBeenLastCalledWith("alpha", "Alpha draft", head.id);
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

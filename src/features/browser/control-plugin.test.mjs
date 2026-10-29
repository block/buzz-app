import { expect, it, vi } from "vitest";
import { apply } from "../../../examples/plugins/browser-control/plugin.js";

function fixture(enabled) {
  let tool;
  const context = {
    browser: {
      available: true,
      View: () => null,
      control: {
        available: async () => enabled,
        open: vi.fn(async () => ({ opened: true })),
        execute: vi.fn(async () => ({ ok: true })),
      },
    },
    panels: { register: vi.fn() },
    agents: {
      addTool: (added) => {
        tool = added;
      },
    },
  };
  return { context, tool: () => tool };
}

it("registers no panel or tool without the native build opt-in", async () => {
  const test = fixture(false);
  await apply(test.context);
  expect(test.context.panels.register).not.toHaveBeenCalled();
  expect(test.tool()).toBeUndefined();
});

it("passes only validated action fields and authenticated caller context to the native boundary", async () => {
  const test = fixture(true);
  await apply(test.context);
  const call = (args) =>
    test.tool().call({ key: "agent" }, { channel: "chat" }, args);
  expect(
    await call({
      token: "grant",
      action: "fill",
      selector: "#name",
      text: "quote '\\",
      grant: true,
    }),
  ).toBe('{"ok":true}');
  expect(test.context.browser.control.execute).toHaveBeenCalledWith(
    "agent",
    { channel: "chat" },
    {
      action: "fill",
      selector: "#name",
      text: "quote '\\",
    },
  );
  await expect(
    call({ token: "grant", action: "eval", script: "evil" }),
  ).rejects.toThrow();
  await expect(
    call({ token: "grant", action: "fill", selector: "input" }),
  ).rejects.toThrow();
  expect(test.tool().inputSchema.properties.token).toBeUndefined();
  expect(test.context.browser.control.execute).toHaveBeenCalledTimes(1);
});

it("opens a page using host-provided identity and conversation, without requesting a UI share", async () => {
  const test = fixture(true);
  await apply(test.context);
  await expect(
    test
      .tool()
      .call(
        { key: "agent" },
        { channel: "chat", root: "thread" },
        { action: "open", url: "https://example.org/" },
      ),
  ).resolves.toBe('{"opened":true}');
  expect(test.context.browser.control.open).toHaveBeenCalledWith(
    "agent",
    { channel: "chat", root: "thread" },
    { url: "https://example.org/", storage: "browser-control-preview" },
  );
  expect(test.context.browser.control.execute).not.toHaveBeenCalled();
});

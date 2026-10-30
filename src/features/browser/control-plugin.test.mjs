import { expect, it, vi } from "vitest";
import { apply } from "../../../examples/plugins/browser-control/plugin.js";

function fixture(enabled) {
  let tool;
  const context = {
    effect: vi.fn(),
    relay: { snapshot: () => ({ scope: "fixture:owner" }) },
    browser: {
      available: true,
      View: () => null,
      control: {
        available: async () => enabled,
        eligible: vi.fn(() => false),
        forRecipient: vi.fn(),
        revokeRecipient: vi.fn(),
        execute: vi.fn(async () => ({ ok: true })),
      },
    },
    panels: { register: vi.fn() },
    agents: {
      snapshot: () => ({ running: [{ key: "agent", pubkey: "agent" }] }),
      addTool: (added) => {
        tool = added;
      },
    },
  };
  return { context, tool: () => tool };
}

it("registers no panel or tool on an unsupported host", async () => {
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

it("rejects an unauthorized open before requesting a panel", async () => {
  const test = fixture(true);
  test.context.panels.requestOpen = vi.fn();
  await apply(test.context);
  await expect(
    test
      .tool()
      .call(
        { key: "agent" },
        { channel: "chat" },
        { action: "open", url: "https://example.org/" },
      ),
  ).rejects.toThrow("cannot open");
  expect(test.context.panels.requestOpen).not.toHaveBeenCalled();
  expect(test.context.browser.control.execute).not.toHaveBeenCalled();
});

it("registers plugin-owned panels without requiring host-owned control views", async () => {
  const test = fixture(true);
  await apply(test.context);
  expect(test.context.browser.control.Page).toBeUndefined();
  expect(test.context.browser.control.View).toBeUndefined();
  expect(test.context.panels.register).toHaveBeenCalledTimes(2);
  expect(test.context.panels.register.mock.calls[0][0].component).toBe(
    test.context.panels.register.mock.calls[1][0].component,
  );
});

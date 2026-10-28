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

it("passes only validated action fields and the owner's token to the native boundary", async () => {
  const test = fixture(true);
  await apply(test.context);
  const call = (args) => test.tool().call({}, {}, args);
  expect(
    await call({
      token: "grant",
      action: "fill",
      selector: "#name",
      text: "quote '\\",
      grant: true,
    }),
  ).toBe('{"ok":true}');
  expect(test.context.browser.control.execute).toHaveBeenCalledWith("grant", {
    action: "fill",
    selector: "#name",
    text: "quote '\\",
  });
  await expect(
    call({ token: "grant", action: "eval", script: "evil" }),
  ).rejects.toThrow();
  await expect(
    call({ token: "grant", action: "fill", selector: "input" }),
  ).rejects.toThrow();
  await expect(call({ action: "observe" })).rejects.toThrow();
  expect(test.context.browser.control.execute).toHaveBeenCalledTimes(1);
});

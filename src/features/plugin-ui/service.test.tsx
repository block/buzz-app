// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement as h, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { COMPONENTS } from "../../shared/design-system/ui/registry";
import type { PluginUi } from "./contract";
import { pluginUi } from "./service";

afterEach(cleanup);

/** Reads `ui` the way a plugin does: optionally, from its own context. */
async function readUi(host: Context) {
  let ui: PluginUi | undefined;
  await host
    .plugin((ctx) => {
      ui = ctx.reflect.get("ui");
    })
    .await();
  return ui;
}

it("is absent on a host without it, so plugins can fall back", async () => {
  expect(await readUi(new Context())).toBeUndefined();
});

it("lets a plugin build a form in a dialog from host controls", async () => {
  const host = new Context();
  host.provide("ui", pluginUi);
  const ui = await readUi(host);
  if (!ui) throw new Error("ui was not provided");
  // React keys components by identity; a fresh one per read would remount.
  expect(ui.Dialog).toBe((await readUi(host))?.Dialog);
  const saved = vi.fn();
  const user = userEvent.setup();

  // Plain JS without the author types, passing props outside the contract.
  const loose = ui as unknown as Record<
    keyof PluginUi,
    (props: Record<string, unknown>) => ReturnType<PluginUi["Button"]>
  >;
  const { Button, Field, Switch } = ui;
  function Page() {
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [alerts, setAlerts] = useState(false);
    const save = () => {
      saved({ name, alerts });
      setOpen(false);
    };
    return h(
      "section",
      null,
      h(
        loose.Button,
        {
          variant: "glass",
          className: "plugin-chrome",
          onClick: () => setOpen(true),
        },
        "Edit profile",
      ),
      h(
        loose.Dialog,
        {
          open,
          onOpenChange: setOpen,
          title: "Profile",
          description: "Shown to people in this community.",
          // Host-owned options are not part of the contract.
          visit: true,
          actions: h(Button, { variant: "prominent", onClick: save }, "Save"),
        },
        h(
          Field,
          { label: "Display name", error: name ? "" : "Required" },
          h(loose.Input, {
            value: name,
            onValueChange: (...args: unknown[]) => setName(args.join("|")),
          }),
        ),
        h(Switch, {
          label: "Desktop alerts",
          checked: alerts,
          onCheckedChange: setAlerts,
        }),
      ),
    );
  }

  const view = render(h(Page));
  const trigger = screen.getByRole("button", { name: "Edit profile" });
  expect(trigger).toHaveAttribute("data-variant", "subtle");
  expect(trigger).not.toHaveClass("plugin-chrome");

  await user.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Profile" });
  expect(dialog).toHaveAccessibleDescription(
    "Shown to people in this community.",
  );
  const input = screen.getByRole("textbox", { name: "Display name" });
  expect(input).toHaveAttribute("aria-invalid", "true");
  await user.type(input, "Ada");
  // Only the value reaches the plugin, never Base UI's event details.
  expect(input).toHaveValue("Ada");
  expect(input).not.toHaveAttribute("aria-invalid");
  await user.click(screen.getByRole("switch", { name: "Desktop alerts" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(saved).toHaveBeenCalledExactlyOnceWith({ name: "Ada", alerts: true });
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  // Disabling the plugin unmounts its page with the dialog open.
  await user.click(trigger);
  await screen.findByRole("dialog", { name: "Profile" });
  await user.keyboard("{Escape}");
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  await screen.findByRole("dialog", { name: "Profile" });
  view.unmount();
  // No leftover portal, inert siblings or scroll lock.
  expect(document.body.innerHTML).toBe("<div></div>");
  await vi.waitFor(() => expect(document.body.style.overflowY).toBe(""));
});

it("keeps the registry's plugin marks in step with what plugins get", () => {
  const marked = COMPONENTS.filter((c) => c.pluginApi === "v1").map(
    (c) => c.name,
  );
  expect(marked.sort()).toEqual(Object.keys(pluginUi).sort());
});

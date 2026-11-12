import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import { PluginAppearanceService } from "./service";

function setup() {
  const release = { attribute: vi.fn(), density: vi.fn() };
  const host = {
    setRootAttribute: vi.fn(() => release.attribute),
    overrideDensity: vi.fn(() => release.density),
  };
  const root = new Context();
  new PluginAppearanceService(root, host);
  const plugin = () =>
    root.extend({ pluginOwner: { id: "example.plugin", revision: "one" } });
  return { root, host, release, plugin };
}

it("applies a plugin's appearance and releases it when the plugin stops", async () => {
  const { root, host, release, plugin } = setup();
  const fiber = plugin().plugin((ctx) => {
    const appearance = ctx.reflect.get("appearance");
    appearance?.setRootAttribute("data-plugin-theme", "example");
    appearance?.overrideMessageDensity("compact");
  });
  await fiber.await();
  expect(host.setRootAttribute).toHaveBeenCalledWith(
    "data-plugin-theme",
    "example",
  );
  expect(host.overrideDensity).toHaveBeenCalledWith("compact");
  expect(release.attribute).not.toHaveBeenCalled();
  expect(release.density).not.toHaveBeenCalled();
  await fiber.dispose();
  expect(release.attribute).toHaveBeenCalledTimes(1);
  expect(release.density).toHaveBeenCalledTimes(1);
  await root.fiber.dispose();
});

it("releases early through the returned function, once", async () => {
  const { root, release, plugin } = setup();
  let clear = () => {};
  const fiber = plugin().plugin((ctx) => {
    clear = ctx.appearance?.overrideMessageDensity("compact") ?? clear;
  });
  await fiber.await();
  clear();
  expect(release.density).toHaveBeenCalledTimes(1);
  await fiber.dispose();
  expect(release.density).toHaveBeenCalledTimes(1);
  await root.fiber.dispose();
});

it("refuses a caller that is not an installed plugin", async () => {
  const { root, host } = setup();
  expect(() => root.appearance?.overrideMessageDensity("compact")).toThrow(
    "Appearance changes must come from an installed plugin",
  );
  expect(host.overrideDensity).not.toHaveBeenCalled();
  await root.fiber.dispose();
});

it("passes a rejected name to the plugin without leaving a claim", async () => {
  const { root, host, release, plugin } = setup();
  host.setRootAttribute.mockImplementationOnce(() => {
    throw new Error("Root attribute must be data-plugin-theme");
  });
  expect(() => plugin().appearance?.setRootAttribute("class", "x")).toThrow(
    "Root attribute must be",
  );
  await root.fiber.dispose();
  expect(release.attribute).not.toHaveBeenCalled();
});

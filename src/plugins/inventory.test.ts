import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import type { AdminAccessState } from "../bundled/admin-access";
import type { PluginManifest } from "./api";
import { providePluginInventory, type PluginInventory } from "./inventory";
import { createPluginManager } from "./manager";
import type { StorageResult } from "./types";

it("shares the committed inventory with a reviewed plugin and enforces current toggle eligibility", async () => {
  function manifest(id: string, host?: PluginManifest["host"]): PluginManifest {
    return { id, name: id, apiVersion: 1, ...(host && { host }) };
  }
  const approved = manifest("example.approved", { pluginInventory: true });
  const unapproved = manifest("example.unapproved");
  const channels = manifest("buzz.channels");
  const moderation = manifest("buzz.moderation");
  const addOn = manifest("example.add-on");
  let catalog: Extract<StorageResult, { status: "ready" }> = {
    status: "ready",
    externalPluginsPaused: false,
    catalog: {
      profile: "test",
      location: "test",
      plugins: [approved, unapproved, channels, moderation, addOn].map(
        (item) => ({
          manifest: item,
          enabled: item !== moderation && item !== addOn,
          source: item === addOn ? "external" : "bundled",
          revision: "one",
          previous: null,
          reloadable: false,
          error: null,
        }),
      ),
    },
  };
  const root = new Context();
  const services = new Map<string, PluginInventory>();
  const manager = createPluginManager(root, {
    bundled: [approved, unapproved, channels, moderation].map((item) => ({
      manifest: item,
      module: {
        inject: ["pluginInventory"],
        apply(ctx) {
          if (ctx.pluginInventory) services.set(item.id, ctx.pluginInventory);
        },
      },
    })),
    storage: {
      async getCatalog() {
        return catalog;
      },
      async changePlugin(action, id) {
        catalog = {
          ...catalog,
          catalog: {
            ...catalog.catalog,
            plugins: catalog.catalog.plugins.map((plugin) =>
              plugin.manifest.id === id
                ? { ...plugin, enabled: action === "enable" }
                : plugin,
            ),
          },
        };
        return catalog;
      },
      async readModule() {
        return "export function apply() {}";
      },
      async recoverSettings() {
        return catalog;
      },
      async reloadPlugin() {
        return catalog;
      },
    },
  });
  let access: AdminAccessState = "denied";
  const accessListeners = new Set<() => void>();
  providePluginInventory(root, manager, {
    status: () => access,
    ensure: () => () => {},
    subscribe(listener) {
      accessListeners.add(listener);
      return () => void accessListeners.delete(listener);
    },
  });

  try {
    await vi.waitFor(() =>
      expect(root.pluginStatus.isActive(approved.id, "one")).toBe(true),
    );
    const inventory = services.get(approved.id);
    const other = services.get(unapproved.id);
    if (!inventory || !other) throw new Error("Test plugins did not start");
    const before = inventory.snapshot();
    expect(before).toBe(inventory.snapshot());
    expect(before).toMatchObject({
      status: "ready",
      plugins: expect.arrayContaining([
        { id: addOn.id, name: addOn.name, source: "add-on", enabled: false },
        {
          id: channels.id,
          name: channels.name,
          source: "built-in",
          enabled: true,
          blockedReason: "Required by Buzz",
        },
      ]),
    });
    expect(other.snapshot()).toMatchObject({ status: "unavailable" });
    await expect(other.setEnabled(addOn.id, true)).rejects.toThrow(
      /permission/,
    );
    await expect(inventory.setEnabled(channels.id, false)).rejects.toThrow(
      /required/i,
    );
    await expect(inventory.setEnabled(moderation.id, true)).rejects.toThrow(
      /owner or admin/,
    );
    const changed = vi.fn();
    inventory.subscribe(changed);

    access = "allowed";
    for (const listener of accessListeners) listener();
    expect(changed).toHaveBeenCalledTimes(1);
    await inventory.setEnabled(moderation.id, true);
    expect(inventory.snapshot()).toMatchObject({
      plugins: expect.arrayContaining([
        expect.objectContaining({ id: moderation.id, enabled: true }),
      ]),
    });
    await manager.change("disable", moderation.id);
    expect(inventory.snapshot()).toMatchObject({
      plugins: expect.arrayContaining([
        expect.objectContaining({ id: moderation.id, enabled: false }),
      ]),
    });
    expect(changed).toHaveBeenCalledTimes(3);
    await manager.change("disable", approved.id);
    await expect(inventory.setEnabled(moderation.id, true)).rejects.toThrow(
      /permission/,
    );
  } finally {
    await manager.dispose();
    await root.fiber.dispose();
  }
});

import type { ComponentType, SVGProps } from "react";
import * as gatewayIcons from "./index";
import { getIconDefinition, type IconDefinition } from "./createDecorativeIcon";

export type GatewayIcon = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number | string }
>;

type GatewayExports = Record<string, unknown>;
type InventoryEntry = {
  name: string;
  component: GatewayIcon;
};
type CustomInventoryEntry = InventoryEntry &
  Omit<Extract<IconDefinition, { source: "custom" }>, "source">;

export function createIconInventory(exports: GatewayExports): {
  phosphor: InventoryEntry[];
  custom: CustomInventoryEntry[];
} {
  const phosphor: InventoryEntry[] = [];
  const custom: CustomInventoryEntry[] = [];

  for (const [name, value] of Object.entries(exports)) {
    const definition = getIconDefinition(value);
    if (!definition)
      throw new Error(`Unclassified icon gateway export: ${name}`);

    const component = value as GatewayIcon;
    if (definition.source === "phosphor") phosphor.push({ name, component });
    else {
      const { source: _, ...detail } = definition;
      custom.push({ name, component, ...detail });
    }
  }

  phosphor.sort((a, b) => a.name.localeCompare(b.name));
  custom.sort((a, b) => a.name.localeCompare(b.name));
  return { phosphor, custom };
}

const inventory = createIconInventory(gatewayIcons);
export const PHOSPHOR_ICONS = inventory.phosphor;
export const CUSTOM_ICONS = inventory.custom;

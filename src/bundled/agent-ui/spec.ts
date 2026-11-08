import type { Spec } from "@json-render/core";
import { z } from "zod";

const text = z.string().max(4000);
const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/);
const binding = z
  .object({ $bindState: z.string().regex(/^\/[A-Za-z][A-Za-z0-9_]{0,39}$/) })
  .strict();

/** Fixed component properties accepted by the card renderer. */
export const agentUiProps = {
  Card: z.object({ title: text }).strict(),
  Text: z.object({ text }).strict(),
  Table: z
    .object({
      columns: z.array(text).min(1).max(6),
      rows: z.array(z.array(text).max(6)).max(32),
    })
    .strict(),
  TextInput: z
    .object({
      label: text,
      value: binding,
      multiline: z.boolean().optional(),
    })
    .strict(),
  Button: z.object({ label: text, action: z.literal("copyDraft") }).strict(),
};

const element = z
  .object({
    type: z.enum(["Card", "Text", "Table", "TextInput", "Button"]),
    props: z.record(z.string(), z.unknown()),
    children: z.array(key).max(32),
  })
  .strict();

const schema = z
  .object({
    version: z.literal(1),
    root: key,
    elements: z.record(key, element),
    state: z.record(key, text),
  })
  .strict();

/** Parse the bounded, data-only card format; reject unsafe or broken trees. */
export function parseAgentUi(source: string): Spec | null {
  if (
    source.length > 32_768 ||
    new TextEncoder().encode(source).length > 32_768
  ) {
    return null;
  }
  try {
    const parsed = schema.safeParse(JSON.parse(source));
    if (!parsed.success) return null;
    const spec = parsed.data;
    if (
      Object.keys(spec.elements).length > 64 ||
      Object.keys(spec.state).length > 16 ||
      spec.elements[spec.root]?.type !== "Card"
    ) {
      return null;
    }
    const visited = new Set<string>();
    const visit = (id: string, depth: number): boolean => {
      if (depth > 8 || visited.has(id)) return false;
      visited.add(id);
      const node = spec.elements[id];
      if (!node || !agentUiProps[node.type].safeParse(node.props).success) {
        return false;
      }
      if (node.type !== "Card" && node.children.length > 0) return false;
      if (node.type === "TextInput") {
        const value = node.props.value as { $bindState: string };
        if (!Object.hasOwn(spec.state, value.$bindState.slice(1))) return false;
      }
      if (node.type === "Table") {
        const props = node.props as { columns: string[]; rows: string[][] };
        if (props.rows.some((row) => row.length !== props.columns.length)) {
          return false;
        }
      }
      return node.children.every((child) => visit(child, depth + 1));
    };
    if (
      !visit(spec.root, 0) ||
      visited.size !== Object.keys(spec.elements).length
    ) {
      return null;
    }
    const nodes = Object.values(spec.elements);
    if (
      nodes.some((node) => node.type === "Button") &&
      !nodes.some((node) => node.type === "TextInput")
    ) {
      return null;
    }
    return { root: spec.root, elements: spec.elements, state: spec.state };
  } catch {
    return null;
  }
}

/** Read current field values in display order when the user copies a draft. */
export function agentUiDraft(
  spec: Spec,
  state: Record<string, unknown>,
): string {
  const fields: string[] = [];
  const visit = (id: string) => {
    const node = spec.elements[id];
    if (!node) return;
    if (node.type === "TextInput") {
      const props = node.props as {
        label: string;
        value: { $bindState: string };
      };
      const value = state[props.value.$bindState.slice(1)];
      fields.push(`${props.label}: ${typeof value === "string" ? value : ""}`);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(spec.root);
  return fields.join("\n\n");
}

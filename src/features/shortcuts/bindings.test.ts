import { describe, expect, it } from "vitest";
import { resolveBindings, type BindingRow, type KeyBinding } from "./bindings";

const dock: KeyBinding = { key: "d", mod: true };
const focus: KeyBinding = { key: "l", mod: true };
const home: KeyBinding = { key: "h", mod: true };
const other: KeyBinding = { key: "p", mod: true };
const resolve = (
  rows: BindingRow[],
  saved: Record<string, unknown>,
  native: readonly KeyBinding[] = [dock],
) => resolveBindings(rows, (key) => saved[key] as never, native);

describe("resolveBindings", () => {
  it("leaves a default someone assigned to another action to that action", () => {
    // Off macOS nothing is native: a new action's default Ctrl+D that a saved
    // shortcut already uses stays with the saved one, and the new one is unbound.
    const resolved = resolve(
      [
        { key: "go-to-dock", defaults: [dock], yields: true },
        { key: "focus-composer", defaults: [focus] },
      ],
      { "focus-composer": [dock] },
      [],
    );
    expect(resolved.get("focus-composer")).toEqual({ effective: [dock] });
    expect(resolved.get("go-to-dock")).toEqual({ effective: [] });
  });

  it("a reset host action gets its default back even when a plugin action saved it", () => {
    // Rebind Search, give its freed chord to a plugin action, then reset
    // Search: Search answers to its default again, listed as shared.
    const resolved = resolve(
      [
        { key: "search", defaults: [focus] },
        { key: "go-to-dock", defaults: [dock], yields: true },
        { key: "plugin/action", defaults: [other] },
      ],
      { "plugin/action": [focus] },
      [],
    );
    expect(resolved.get("search")).toEqual({ effective: [focus] });
    expect(resolved.get("plugin/action")).toEqual({ effective: [focus] });
    expect(resolved.get("go-to-dock")).toEqual({ effective: [dock] });
  });

  it("lists a plugin default someone assigned elsewhere as shared, for them to settle", () => {
    const resolved = resolve(
      [
        { key: "saved", defaults: [focus] },
        { key: "plugin/action", defaults: [home] },
      ],
      { saved: [home] },
      [],
    );
    expect(resolved.get("plugin/action")).toEqual({ effective: [home] });
    expect(resolved.get("saved")).toEqual({ effective: [home] });
  });

  it("keeps the free aliases of a default when another action holds one", () => {
    const resolved = resolve(
      [
        { key: "search", defaults: [focus, home], yields: true },
        { key: "b", defaults: [other] },
      ],
      { b: [home] },
      [],
    );
    expect(resolved.get("search")).toEqual({ effective: [focus] });
  });

  it("a field-local override and a global default never take each other's chord", () => {
    const resolved = resolve(
      [
        { key: "global", defaults: [focus], yields: true },
        { key: "field", defaults: [home], local: true },
      ],
      { field: [focus] },
      [],
    );
    expect(resolved.get("global")).toEqual({ effective: [focus] });
    expect(resolved.get("field")).toEqual({ effective: [focus] });
  });

  it("a native default keeps its chord over a saved override the native chord masks", () => {
    const resolved = resolve(
      [
        { key: "go-to-dock", defaults: [dock], yields: true },
        { key: "focus-composer", defaults: [focus] },
      ],
      { "focus-composer": [dock] },
    );
    expect(resolved.get("go-to-dock")).toEqual({ effective: [dock] });
    expect(resolved.get("focus-composer")?.effective).toEqual([focus]);
  });

  it("gives a row with no override its defaults", () => {
    const resolved = resolve([{ key: "a", defaults: [focus, home] }], {});
    expect(resolved.get("a")).toEqual({ effective: [focus, home] });
  });

  it("applies an override that is not a native chord, even over another row's default", () => {
    const resolved = resolve(
      [
        { key: "a", defaults: [focus] },
        { key: "b", defaults: [home] },
      ],
      { a: [other], b: [focus] },
    );
    expect(resolved.get("a")).toEqual({ effective: [other] });
    expect(resolved.get("b")).toEqual({ effective: [focus] });
  });

  it("restores the default of a row whose override a native chord took, when the default is free", () => {
    const resolved = resolve([{ key: "a", defaults: [focus] }], { a: [dock] });
    expect(resolved.get("a")).toEqual({
      effective: [focus],
      masked: { override: [dock], restored: true },
    });
  });

  it("masks an override on any of several native chords and matches keys case-insensitively", () => {
    const resolved = resolve([{ key: "a", defaults: [focus] }], {
      a: [{ key: "D", mod: true }],
    });
    expect(resolved.get("a")?.masked?.restored).toBe(true);
    // A different modifier set is not the native chord.
    const shifted = resolve([{ key: "a", defaults: [focus] }], {
      a: [{ key: "d", mod: true, shift: true }],
    });
    expect(shifted.get("a")).toEqual({
      effective: [{ key: "d", mod: true, shift: true }],
    });
  });

  it("leaves a masked row unbound when another row's override took its default", () => {
    const resolved = resolve(
      [
        { key: "a", defaults: [focus] },
        { key: "b", defaults: [home] },
      ],
      { a: [dock], b: [focus] },
    );
    expect(resolved.get("b")).toEqual({ effective: [focus] });
    expect(resolved.get("a")).toEqual({
      effective: [],
      masked: { override: [dock], restored: false },
    });
  });

  it("leaves a masked row unbound when another row's own default holds its default chord", () => {
    const resolved = resolve(
      [
        { key: "a", defaults: [focus] },
        { key: "b", defaults: [focus] },
      ],
      { a: [dock] },
    );
    expect(resolved.get("b")).toEqual({ effective: [focus] });
    expect(resolved.get("a")?.effective).toEqual([]);
    expect(resolved.get("a")?.masked?.restored).toBe(false);
  });

  it("leaves a masked row unbound when its default is itself native", () => {
    const resolved = resolve([{ key: "a", defaults: [dock] }], { a: [dock] });
    expect(resolved.get("a")).toEqual({
      effective: [],
      masked: { override: [dock], restored: false },
    });
    // One native default among several is enough to refuse the restore.
    const mixed = resolve([{ key: "a", defaults: [focus, dock] }], {
      a: [dock],
    });
    expect(mixed.get("a")?.effective).toEqual([]);
  });

  it("gives a default shared by two masked rows to the first in row order", () => {
    const rows: BindingRow[] = [
      { key: "a", defaults: [focus] },
      { key: "b", defaults: [focus] },
    ];
    const saved = { a: [dock], b: [dock] };
    const forward = resolve(rows, saved);
    expect(forward.get("a")?.effective).toEqual([focus]);
    expect(forward.get("a")?.masked?.restored).toBe(true);
    expect(forward.get("b")?.effective).toEqual([]);
    expect(forward.get("b")?.masked?.restored).toBe(false);
    const reversed = resolve([...rows].reverse(), saved);
    expect(reversed.get("b")?.effective).toEqual([focus]);
    expect(reversed.get("a")?.effective).toEqual([]);
  });

  it("does not let a field-local row and a global row take each other's chords", () => {
    const resolved = resolve(
      [
        { key: "a", defaults: [focus], local: true },
        { key: "b", defaults: [focus] },
      ],
      { a: [dock] },
    );
    expect(resolved.get("a")?.effective).toEqual([focus]);
    expect(resolved.get("a")?.masked?.restored).toBe(true);
  });

  it("applies every override unchanged when no chord is native", () => {
    const resolved = resolve(
      [
        { key: "a", defaults: [focus] },
        { key: "b", defaults: [home] },
      ],
      { a: [dock], b: [focus] },
      [],
    );
    expect(resolved.get("a")).toEqual({ effective: [dock] });
    expect(resolved.get("b")).toEqual({ effective: [focus] });
  });

  it.each([
    ["a bare binding", { key: "d", mod: true }],
    ["an empty list", []],
    ["a string", "⌘D"],
    ["a list with a malformed binding", [{ key: 5 }]],
    ["null", null],
  ])("gives a row whose override is %s its defaults", (_name, saved) => {
    const resolved = resolve([{ key: "a", defaults: [focus] }], { a: saved });
    expect(resolved.get("a")).toEqual({ effective: [focus] });
  });

  it("never mutates the saved overrides or the rows", () => {
    const saved = { a: [dock] };
    const rows: BindingRow[] = [{ key: "a", defaults: [focus] }];
    const before = JSON.stringify({ saved, rows });
    resolve(rows, saved);
    expect(JSON.stringify({ saved, rows })).toBe(before);
  });
});

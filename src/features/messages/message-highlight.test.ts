// @vitest-environment jsdom
import { expect, it } from "vitest";
import { highlightMessage } from "./message-highlight";
import styles from "./Messages.module.css";

it.each([
  ["cleanup", "return"],
  ["abort", "return"],
  ["cleanup", "linked"],
  ["abort", "linked"],
] as const)("an older cue's %s cannot clear a newer %s cue", (end, mode) => {
  const row = document.createElement("div");
  const request = new AbortController();
  const first = highlightMessage(row, request.signal);
  const second = highlightMessage(row, undefined, mode);
  const style =
    mode === "linked" ? styles.linkedHighlight : styles.returnHighlight;
  if (end === "cleanup") first();
  else request.abort();
  expect(row.classList.contains(style ?? "")).toBe(true);
  second();
  expect(row.classList.contains(style ?? "")).toBe(false);
});

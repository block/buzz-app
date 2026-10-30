// @vitest-environment jsdom
import { expect, it } from "vitest";
import { highlightMessage } from "./message-highlight";
import styles from "./Messages.module.css";

it.each(["cleanup", "abort"])(
  "an older cue's %s cannot clear a newer cue",
  (end) => {
    const row = document.createElement("div");
    const request = new AbortController();
    const first = highlightMessage(row, request.signal);
    const second = highlightMessage(row);
    if (end === "cleanup") first();
    else request.abort();
    expect(row.classList.contains(styles.returnHighlight ?? "")).toBe(true);
    second();
    expect(row.classList.contains(styles.returnHighlight ?? "")).toBe(false);
  },
);

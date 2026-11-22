import { useSyncExternalStore } from "react";

export type DiffLayout = "unified" | "split";
const key = "buzz.github.diff-layout.v1";
const changed = "buzz-github-diff-layout-changed";
function read(): DiffLayout {
  try {
    return localStorage.getItem(key) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}
export function setDiffLayout(layout: DiffLayout) {
  localStorage.setItem(key, layout);
  window.dispatchEvent(new Event(changed));
}
function subscribe(notify: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) notify();
  };
  window.addEventListener(changed, notify);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(changed, notify);
    window.removeEventListener("storage", storage);
  };
}
export function useDiffLayout() {
  return useSyncExternalStore(subscribe, read);
}

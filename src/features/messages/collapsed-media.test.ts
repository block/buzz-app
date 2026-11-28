// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import {
  clearView,
  clearViewScope,
  readView,
  writeView,
} from "../../shared/view-state";
import {
  mediaCollapsed,
  setMediaCollapsed,
  subscribeCollapsedMedia,
} from "./collapsed-media";

it("stores the newest 500 collapsed groups per scope", () => {
  for (let id = 0; id <= 500; id++)
    setMediaCollapsed("channel", String(id), true);
  expect(readView<string[]>("channel", "collapsed-media", [])).toHaveLength(
    500,
  );
  expect(mediaCollapsed("channel", "0")).toBe(false);
  expect(mediaCollapsed("channel", "1")).toBe(true);
  expect(mediaCollapsed("channel", "500")).toBe(true);
  expect(mediaCollapsed("elsewhere", "500")).toBe(false);
});

it.each(["two-views", undefined])(
  "keeps two views in agreement in scope %s",
  (scope) => {
    const first: boolean[] = [];
    const second: boolean[] = [];
    const stop = [first, second].map((values) =>
      subscribeCollapsedMedia(scope, () =>
        values.push(mediaCollapsed(scope, "one")),
      ),
    );
    try {
      setMediaCollapsed(scope, "one", true);
      setMediaCollapsed(scope, "one", false);
      expect(first).toEqual([true, false]);
      expect(second).toEqual(first);
    } finally {
      for (const unsubscribe of stop) unsubscribe();
    }
  },
);

it("keeps a group choice in this page when storage is full and saves it when storage recovers", () => {
  const scope = "storage-full";
  const seen: boolean[] = [];
  const stop = subscribeCollapsedMedia(scope, () =>
    seen.push(mediaCollapsed(scope, "one")),
  );
  const draft = "draft:general";
  writeView(scope, draft, { text: "Saved draft" });
  writeView(scope, `${draft}:files`, ["attachment"]);
  const writer = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementationOnce(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
  try {
    setMediaCollapsed(scope, "one", true);
    expect(mediaCollapsed(scope, "one")).toBe(true);
    expect(mediaCollapsed("other-scope", "one")).toBe(false);
    expect(readView(scope, "collapsed-media", [])).toEqual([]);
    clearView(scope, draft, `${draft}:files`);
    expect(mediaCollapsed(scope, "one")).toBe(true);
    clearView(scope, draft, `${draft}:files`);
    expect(mediaCollapsed(scope, "one")).toBe(true);
    setMediaCollapsed(scope, "two", true);
    expect(readView(scope, "collapsed-media", [])).toEqual(["one", "two"]);
    expect(seen).toContain(true);
    expect(seen).not.toContain(false);

    writer.mockImplementationOnce(() => {
      throw new Error("Storage full");
    });
    setMediaCollapsed(scope, "three", true);
    clearView(scope, "collapsed-media", draft);
    expect(mediaCollapsed(scope, "three")).toBe(false);

    writer.mockImplementationOnce(() => {
      throw new Error("Storage full");
    });
    setMediaCollapsed(scope, "one", true);
    clearViewScope(scope);
    expect(mediaCollapsed(scope, "one")).toBe(false);
  } finally {
    writer.mockRestore();
    stop();
  }
});

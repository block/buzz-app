import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPreferencesStore } from "./preferences";

const DEFAULTS = {
  vipLogins: [],
  watchedLabels: [],
  hiddenReviewRequestUrls: [],
  pollingEnabled: false,
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createPreferencesStore", () => {
  it("defaults to empty lists and polling off", () => {
    const store = createPreferencesStore();
    expect(store.getPreferences()).toEqual(DEFAULTS);
  });

  it("persists changes to localStorage under a plugin-scoped key", () => {
    const store = createPreferencesStore();
    store.setPreferences({
      vipLogins: ["octocat"],
      watchedLabels: ["bug"],
      hiddenReviewRequestUrls: ["https://github.com/example/repo/pull/1"],
      pollingEnabled: true,
    });

    const reloaded = createPreferencesStore();
    expect(reloaded.getPreferences()).toEqual({
      vipLogins: ["octocat"],
      watchedLabels: ["bug"],
      hiddenReviewRequestUrls: ["https://github.com/example/repo/pull/1"],
      pollingEnabled: true,
    });
    expect(
      localStorage.getItem("buzz-plugin.com.bostonaholic.pr-beacon.v1"),
    ).toBeTruthy();
  });

  it("notifies subscribers on change", () => {
    const store = createPreferencesStore();
    let notified = false;
    store.subscribe(() => {
      notified = true;
    });
    store.setPreferences({ ...DEFAULTS, vipLogins: ["a"] });
    expect(notified).toBe(true);
  });

  it("falls back to defaults on malformed stored data", () => {
    localStorage.setItem(
      "buzz-plugin.com.bostonaholic.pr-beacon.v1",
      "not json",
    );
    const store = createPreferencesStore();
    expect(store.getPreferences()).toEqual(DEFAULTS);
  });

  it("drops non-string entries from stored arrays instead of trusting malformed data", () => {
    localStorage.setItem(
      "buzz-plugin.com.bostonaholic.pr-beacon.v1",
      JSON.stringify({
        vipLogins: ["octocat", 42, null],
        watchedLabels: [{ not: "a string" }, "bug"],
        hiddenReviewRequestUrls: [
          "https://github.com/example/repo/pull/1",
          true,
        ],
        pollingEnabled: true,
      }),
    );
    const store = createPreferencesStore();
    expect(store.getPreferences()).toEqual({
      vipLogins: ["octocat"],
      watchedLabels: ["bug"],
      hiddenReviewRequestUrls: ["https://github.com/example/repo/pull/1"],
      pollingEnabled: true,
    });
  });

  it("has no save error initially", () => {
    const store = createPreferencesStore();
    expect(store.getSaveError()).toBeNull();
  });

  it("exposes a save error instead of throwing when localStorage.setItem fails, and still updates in memory", () => {
    const store = createPreferencesStore();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    store.setPreferences({ ...DEFAULTS, vipLogins: ["a"] });

    expect(store.getPreferences().vipLogins).toEqual(["a"]);
    expect(store.getSaveError()).toBe("QuotaExceededError");
  });

  it("clears a prior save error once a save succeeds", () => {
    const store = createPreferencesStore();
    const setItemSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementationOnce(() => {
        throw new Error("boom");
      });
    store.setPreferences({ ...DEFAULTS, vipLogins: ["a"] });
    setItemSpy.mockRestore();

    store.setPreferences({ ...DEFAULTS, vipLogins: ["b"] });
    expect(store.getSaveError()).toBeNull();
  });
});

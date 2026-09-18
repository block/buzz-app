import { describe, expect, it, vi } from "vitest";
import { STORAGE_KEY, createBoardStore } from "./store";

function fakeLocalStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

describe("createBoardStore", () => {
  it("starts empty and persists an added task", () => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    const store = createBoardStore();
    expect(store.snapshot().tasks).toEqual([]);

    store.addTask("Review PR", "Human");
    const { tasks, saveError } = store.snapshot();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Review PR");
    expect(tasks[0].status).toBe("queued");
    expect(saveError).toBeUndefined();

    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) as string);
    expect(persisted).toHaveLength(1);
  });

  it("recovers from malformed saved data instead of crashing", () => {
    vi.stubGlobal(
      "localStorage",
      fakeLocalStorage({ [STORAGE_KEY]: "not json" }),
    );
    const store = createBoardStore();
    expect(store.snapshot().tasks).toEqual([]);
    expect(store.snapshot().recoveredFromInvalidData).toBe(true);
  });

  it("reflects a previously saved task in the very first snapshot, before any mutation", () => {
    vi.stubGlobal(
      "localStorage",
      fakeLocalStorage({
        [STORAGE_KEY]: JSON.stringify([
          { id: "1", title: "Saved earlier", owner: "Human", status: "done" },
        ]),
      }),
    );
    const store = createBoardStore();
    expect(store.snapshot().tasks).toEqual([
      { id: "1", title: "Saved earlier", owner: "Human", status: "done" },
    ]);
  });

  it("drops invalid entries from a partially valid saved list", () => {
    vi.stubGlobal(
      "localStorage",
      fakeLocalStorage({
        [STORAGE_KEY]: JSON.stringify([
          { id: "1", title: "Valid task", owner: "Human", status: "queued" },
          { id: "2", title: "Bad owner", owner: "Robot", status: "queued" },
          { title: "Missing id", owner: "Agent", status: "done" },
        ]),
      }),
    );
    const store = createBoardStore();
    const { tasks, recoveredFromInvalidData } = store.snapshot();
    expect(tasks).toEqual([
      { id: "1", title: "Valid task", owner: "Human", status: "queued" },
    ]);
    expect(recoveredFromInvalidData).toBe(true);
  });

  it("reports a save error without losing in-memory state, and never claims success", () => {
    const storage = fakeLocalStorage();
    vi.stubGlobal("localStorage", {
      ...storage,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    });
    const store = createBoardStore();
    store.addTask("Ship it", "Agent");
    const { tasks, saveError } = store.snapshot();
    expect(tasks).toHaveLength(1);
    expect(saveError).toBeTruthy();
  });

  it("updates status and removes tasks", () => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    const store = createBoardStore();
    store.addTask("Deploy", "Human");
    const id = store.snapshot().tasks[0].id;

    store.setStatus(id, "in-progress");
    expect(store.snapshot().tasks[0].status).toBe("in-progress");

    store.removeTask(id);
    expect(store.snapshot().tasks).toEqual([]);
  });
});

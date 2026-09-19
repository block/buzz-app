export const STORAGE_KEY = "buzz-plugin.local.handoff-board.v1";
export const OWNERS = ["Human", "Agent"] as const;
export const STATUSES = ["queued", "in-progress", "done"] as const;
export const STATUS_LABELS: Record<Status, string> = {
  queued: "Queued",
  "in-progress": "In progress",
  done: "Done",
};

export type Owner = (typeof OWNERS)[number];
export type Status = (typeof STATUSES)[number];
export type Task = Readonly<{
  id: string;
  title: string;
  owner: Owner;
  status: Status;
}>;
export type BoardSnapshot = Readonly<{
  tasks: readonly Task[];
  recoveredFromInvalidData: boolean;
  saveError: string | undefined;
}>;

export function isTask(value: unknown): value is Task {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    record.title.trim().length > 0 &&
    OWNERS.includes(record.owner as Owner) &&
    STATUSES.includes(record.status as Status)
  );
}

function createId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

// Plugin-namespaced localStorage: the host has no plugin persistence API yet
// (README.md: "Plugin-specific persistent data has no host API yet"). Scoped to the
// browser/WebView origin, not to a BUZZODZ_PROFILE, community, or account — it is not
// isolated by those boundaries, and it is not synced or shared across devices/origins.
// Uninstalling the plugin does not delete this data.
export function createBoardStore() {
  let tasks: Task[] = [];
  let recoveredFromInvalidData = false;
  let saveError: string | undefined;
  const listeners = new Set<() => void>();
  let cachedSnapshot: BoardSnapshot = {
    tasks,
    recoveredFromInvalidData,
    saveError,
  };

  function notify() {
    cachedSnapshot = { tasks, recoveredFromInvalidData, saveError };
    for (const listener of listeners) listener();
  }

  function load() {
    let raw: string | null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      saveError =
        "Local storage is unavailable in this browser; the board will not persist.";
      return;
    }
    if (raw === null) return;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("saved board is not a list");
      const valid = parsed.filter(isTask);
      recoveredFromInvalidData = valid.length !== parsed.length;
      tasks = valid;
    } catch {
      tasks = [];
      recoveredFromInvalidData = true;
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
      saveError = undefined;
    } catch {
      saveError =
        "Could not save the board to local storage. This change may be lost on reload.";
    }
    notify();
  }

  load();
  cachedSnapshot = { tasks, recoveredFromInvalidData, saveError };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot(): BoardSnapshot {
      return cachedSnapshot;
    },
    addTask(title: string, owner: Owner) {
      const trimmed = title.trim();
      if (!trimmed) return;
      tasks = [
        ...tasks,
        { id: createId(), title: trimmed, owner, status: "queued" },
      ];
      persist();
    },
    setStatus(id: string, status: Status) {
      tasks = tasks.map((task) =>
        task.id === id ? { ...task, status } : task,
      );
      persist();
    },
    removeTask(id: string) {
      tasks = tasks.filter((task) => task.id !== id);
      persist();
    },
    dismissRecoveryNotice() {
      recoveredFromInvalidData = false;
      notify();
    },
  };
}

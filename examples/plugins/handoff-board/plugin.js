//#region src/store.ts
var STORAGE_KEY = "buzz-plugin.local.handoff-board.v1";
var OWNERS = ["Human", "Agent"];
var STATUSES = ["queued", "in-progress", "done"];
var STATUS_LABELS = {
  queued: "Queued",
  "in-progress": "In progress",
  done: "Done",
};
function isTask(value) {
  if (!value || typeof value !== "object") return false;
  const record = value;
  return (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    record.title.trim().length > 0 &&
    OWNERS.includes(record.owner) &&
    STATUSES.includes(record.status)
  );
}
function createId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
function createBoardStore() {
  let tasks = [];
  let recoveredFromInvalidData = false;
  let saveError;
  const listeners = /* @__PURE__ */ new Set();
  let cachedSnapshot = {
    tasks,
    recoveredFromInvalidData,
    saveError,
  };
  function notify() {
    cachedSnapshot = {
      tasks,
      recoveredFromInvalidData,
      saveError,
    };
    for (const listener of listeners) listener();
  }
  function load() {
    let raw;
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
      saveError = void 0;
    } catch {
      saveError =
        "Could not save the board to local storage. This change may be lost on reload.";
    }
    notify();
  }
  load();
  cachedSnapshot = {
    tasks,
    recoveredFromInvalidData,
    saveError,
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot() {
      return cachedSnapshot;
    },
    addTask(title, owner) {
      const trimmed = title.trim();
      if (!trimmed) return;
      tasks = [
        ...tasks,
        {
          id: createId(),
          title: trimmed,
          owner,
          status: "queued",
        },
      ];
      persist();
    },
    setStatus(id, status) {
      tasks = tasks.map((task) =>
        task.id === id
          ? {
              ...task,
              status,
            }
          : task,
      );
      persist();
    },
    removeTask(id) {
      tasks = tasks.filter((task) => task.id !== id);
      persist();
    },
    dismissRecoveryNotice() {
      recoveredFromInvalidData = false;
      notify();
    },
  };
}
//#endregion
//#region src/index.tsx
var inject = ["react", "pages", "panels", "navigation", "shortcuts"];
var LAUNCHER_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23333' stroke-width='2'%3E%3Crect x='3' y='4' width='18' height='17' rx='2'/%3E%3Cpath d='M8 2v4M16 2v4M4 10h16'/%3E%3Cpath d='M8 14l2 2 4-4'/%3E%3C/svg%3E";
function createBoard(React, store) {
  function TaskForm({ onAdd }) {
    const [title, setTitle] = React.useState("");
    const [owner, setOwner] = React.useState("Human");
    return React.createElement(
      "form",
      {
        onSubmit: (event) => {
          event.preventDefault();
          if (!title.trim()) return;
          onAdd(title, owner);
          setTitle("");
        },
        style: {
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
        },
      },
      React.createElement(
        "label",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            fontSize: 12,
            flex: "1 1 200px",
          },
        },
        "Task title",
        React.createElement("input", {
          value: title,
          onChange: (event) => setTitle(event.target.value),
          placeholder: "e.g. Review PR #42",
          style: {
            padding: "6px 8px",
            fontSize: 14,
          },
        }),
      ),
      React.createElement(
        "label",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            fontSize: 12,
          },
        },
        "Owner",
        React.createElement(
          "select",
          {
            value: owner,
            onChange: (event) => setOwner(event.target.value),
            style: {
              padding: "6px 8px",
              fontSize: 14,
            },
          },
          OWNERS.map((value) =>
            React.createElement(
              "option",
              {
                key: value,
                value,
              },
              value,
            ),
          ),
        ),
      ),
      React.createElement(
        "button",
        {
          type: "submit",
          disabled: !title.trim(),
          style: {
            padding: "6px 12px",
            alignSelf: "flex-end",
          },
        },
        "Add task",
      ),
    );
  }
  function TaskRow({ task }) {
    return React.createElement(
      "li",
      {
        key: task.id,
        style: {
          display: "flex",
          gap: 8,
          alignItems: "center",
          padding: "6px 0",
          borderBottom: "1px solid #e5e5e5",
        },
      },
      React.createElement("span", { style: { flex: 1 } }, task.title),
      React.createElement(
        "span",
        {
          style: {
            fontSize: 12,
            padding: "2px 8px",
            borderRadius: 12,
            background: task.owner === "Agent" ? "#e6f0ff" : "#eef7e6",
          },
        },
        task.owner,
      ),
      React.createElement(
        "label",
        { style: { fontSize: 12 } },
        React.createElement(
          "span",
          { style: { display: "none" } },
          `Status for ${task.title}`,
        ),
        React.createElement(
          "select",
          {
            "aria-label": `Status for ${task.title}`,
            value: task.status,
            onChange: (event) => store.setStatus(task.id, event.target.value),
            style: {
              padding: "4px 6px",
              fontSize: 12,
            },
          },
          STATUSES.map((value) =>
            React.createElement(
              "option",
              {
                key: value,
                value,
              },
              STATUS_LABELS[value],
            ),
          ),
        ),
      ),
      React.createElement(
        "button",
        {
          type: "button",
          "aria-label": `Remove ${task.title}`,
          onClick: () => store.removeTask(task.id),
          style: {
            padding: "4px 8px",
            fontSize: 12,
          },
        },
        "Remove",
      ),
    );
  }
  function Board({ compact }) {
    const state = React.useSyncExternalStore(store.subscribe, store.snapshot);
    return React.createElement(
      "section",
      {
        style: {
          padding: compact ? 12 : 24,
          background: "white",
          borderRadius: compact ? 12 : 24,
          maxWidth: compact ? 320 : void 0,
          fontFamily: "inherit",
        },
      },
      React.createElement(
        "h1",
        {
          style: {
            fontSize: compact ? 16 : 22,
            margin: "0 0 8px",
          },
        },
        "Handoff Board",
      ),
      !compact &&
        React.createElement(
          "p",
          {
            style: {
              fontSize: 13,
              color: "#666",
              margin: "0 0 12px",
            },
          },
          "Local-only queue of tasks to hand off between you and an agent. Saved to this browser's local storage; not synced or shared with anyone else.",
        ),
      state.saveError &&
        React.createElement(
          "p",
          {
            role: "alert",
            style: {
              color: "#a30000",
              fontSize: 13,
              margin: "0 0 12px",
            },
          },
          state.saveError,
        ),
      state.recoveredFromInvalidData &&
        React.createElement(
          "p",
          {
            role: "status",
            style: {
              color: "#8a6100",
              fontSize: 13,
              margin: "0 0 12px",
            },
          },
          "Some saved data could not be read and was skipped. ",
          React.createElement(
            "button",
            {
              type: "button",
              onClick: store.dismissRecoveryNotice,
              style: {
                fontSize: 12,
                marginLeft: 4,
              },
            },
            "Dismiss",
          ),
        ),
      React.createElement(TaskForm, { onAdd: store.addTask }),
      state.tasks.length === 0
        ? React.createElement(
            "p",
            {
              role: "status",
              style: {
                fontSize: 13,
                color: "#666",
                marginTop: 16,
              },
            },
            "No tasks yet. Add one above.",
          )
        : React.createElement(
            "ul",
            {
              style: {
                listStyle: "none",
                margin: "16px 0 0",
                padding: 0,
              },
            },
            state.tasks.map((task) =>
              React.createElement(TaskRow, {
                key: task.id,
                task,
              }),
            ),
          ),
    );
  }
  return Board;
}
function apply(ctx) {
  const React = ctx.react;
  const Board = createBoard(React, createBoardStore());
  ctx.pages.register({
    id: "board",
    title: "Handoff Board",
    component: function HandoffBoardPage() {
      return React.createElement(Board, { compact: false });
    },
  });
  ctx.panels.register({
    id: "board",
    title: "Handoff Board",
    matches: () => false,
    launcher: {
      icon: LAUNCHER_ICON,
      target: "",
    },
    component: function HandoffBoardPanel() {
      return React.createElement(Board, { compact: true });
    },
  });
  ctx.shortcuts.register({
    id: "open-handoff-board",
    title: "Open Handoff Board",
    binding: {
      key: "h",
      mod: true,
      shift: true,
    },
    run: () => {
      ctx.navigation.open({
        version: 1,
        kind: "page",
        pluginId: "local.handoff-board",
        pageId: "board",
      });
    },
  });
}
//#endregion
export { apply, inject };

import { expect, it } from "vitest";
import {
  checkedFields,
  isMine,
  type Task,
  TASK_TYPE,
  taskContent,
  taskOf,
  taskTags,
} from "./model";

const author = "a".repeat(64);
const editor = "b".repeat(64);
const third = "c".repeat(64);
const id = "11111111-1111-4111-8111-111111111111";
const home = "22222222-2222-4222-8222-222222222222";

const revision = (content: unknown, tags: string[][] = []) => ({
  id: "e".repeat(64),
  pubkey: editor,
  sig: "",
  created_at: 10,
  kind: 45010,
  content: typeof content === "string" ? content : JSON.stringify(content),
  tags: [
    ["ar", "1"],
    ["d", id],
    ["h", home],
    ["type", TASK_TYPE],
    ["title", "Fix the header"],
    ["op", "update"],
    ...tags,
  ],
});

it("reads a revision as the task it snapshots, in its home", () => {
  const task = taskOf(
    revision(
      {
        version: 3,
        description: "It clips.",
        images: [
          { url: "https://example.org/a.png", type: "image/png", dim: "10x20" },
        ],
      },
      [
        ["status", "in_progress"],
        ["assignee", author],
        ["assignee", author],
        ["assignee", third],
        ["creator", author],
        ["via", third],
      ],
    ),
  );
  expect(task).toEqual({
    id,
    home,
    title: "Fix the header",
    description: "It clips.",
    status: "in_progress",
    images: [
      { url: "https://example.org/a.png", type: "image/png", dim: "10x20" },
    ],
    assignees: [author, third],
    creator: author,
    via: third,
    revision: "e".repeat(64),
    editor,
    updatedAt: 10,
  });
});

it("trusts only tags for what the relay checks, never content", () => {
  // An app could write a creator, status or assignees into content; none of
  // it counts.
  const task = taskOf(
    revision(
      {
        author: third,
        creator: third,
        status: "done",
        assignees: [third],
      },
      [],
    ),
  );
  expect(task?.creator).toBeUndefined();
  expect(task?.status).toBe("todo");
  expect(task?.assignees).toEqual([]);
});

it("drops what an untrusted record can't safely show", () => {
  const task = taskOf(
    revision(
      {
        images: [
          { url: "http://example.org/a.png" },
          { url: "javascript:alert(1)" },
          { url: "https://example.org/b.png", type: "text/html", dim: "big" },
        ],
      },
      [
        ["status", "deleted"],
        ["creator", "not a key"],
        ["via", "nobody"],
        ...["someone", "d".repeat(64), "1".repeat(64), "2".repeat(64)].map(
          (key) => ["assignee", key],
        ),
        ...["3", "4"].map((n) => ["assignee", n.repeat(64)]),
      ],
    ),
  );
  expect(task?.creator).toBeUndefined();
  expect(task?.via).toBeUndefined();
  expect(task?.status).toBe("todo");
  expect(task?.images).toEqual([{ url: "https://example.org/b.png" }]);
  expect(task?.assignees).toEqual([
    "d".repeat(64),
    "1".repeat(64),
    "2".repeat(64),
    "3".repeat(64),
  ]);
  expect(taskOf(revision("not json"))).toBeUndefined();
  expect(taskOf(revision([]))).toBeUndefined();
  // A task needs a home; one from the old shared store had none of its own.
  expect(
    taskOf({
      ...revision({}),
      tags: [
        ["d", id],
        ["h", "tasks"],
        ["type", TASK_TYPE],
      ],
    }),
  ).toBeUndefined();
  expect(
    taskOf({
      ...revision({}),
      tags: [
        ["d", id],
        ["h", home],
        ["type", "other"],
      ],
    }),
  ).toBeUndefined();
});

it("checks fields before saving, with reasons people can act on", () => {
  const fields = {
    title: "  Fix   the header ",
    description: "",
    status: "todo" as const,
    images: [],
    assignees: [author, author],
  };
  expect(checkedFields(fields)).toEqual({
    ...fields,
    title: "Fix the header",
    assignees: [author],
  });
  expect(() => checkedFields({ ...fields, title: " " })).toThrow(
    "Give the task a title.",
  );
  expect(() => checkedFields({ ...fields, title: "x".repeat(201) })).toThrow(
    "under 200",
  );
  expect(() => checkedFields({ ...fields, assignees: ["someone"] })).toThrow(
    "Assign people only.",
  );
  expect(() =>
    checkedFields({
      ...fields,
      assignees: ["1", "2", "3", "4", "5"].map((n) => n.repeat(64)),
    }),
  ).toThrow("up to 4");
  expect(JSON.parse(taskContent(checkedFields(fields)))).toEqual({
    version: 3,
    description: "",
    images: [],
  });
  expect(taskTags(checkedFields(fields))).toEqual([
    ["status", "todo"],
    ["assignee", author],
  ]);
});

it("counts a task as mine when I made it or I'm assigned", () => {
  const task = taskOf(revision({}, [["creator", editor]])) as Task;
  expect(isMine(task, editor)).toBe(true);
  expect(isMine(task, author)).toBe(false);
  expect(isMine({ ...task, assignees: [author] }, author)).toBe(true);
});

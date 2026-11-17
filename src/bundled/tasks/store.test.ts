import { expect, it, vi } from "vitest";
import { PublishRejected } from "../../features/relay/outbox";
import type { RelaySession } from "../../features/relay/session";
import { TASK_TYPE, type Task, type TaskFields, taskOf } from "./model";
import { NOT_A_TASK_PLACE, readTask, saveTask, TaskRefused } from "./store";

const viewer = "a".repeat(64);
const id = "11111111-1111-4111-8111-111111111111";
const home = "22222222-2222-4222-8222-222222222222";
const away = "33333333-3333-4333-8333-333333333333";
const fields: TaskFields = {
  title: "Fix the header",
  description: "It clips.",
  status: "todo",
  images: [],
  assignees: [],
};
const head = (revision: string, content: object = {}, at = home) => ({
  id: revision,
  pubkey: "b".repeat(64),
  sig: "",
  created_at: 5,
  kind: 45010,
  content: JSON.stringify({ version: 2, author: viewer, ...content }),
  tags: [
    ["ar", "1"],
    ["d", id],
    ["h", at],
    ["type", TASK_TYPE],
    ["title", "Fix the header"],
    ["op", "update"],
  ],
});

const relayKey = "e".repeat(64);
const riley = "c".repeat(64);
const dm = "44444444-4444-4444-8444-444444444444";
const huddle = "55555555-5555-4555-8555-555555555555";
const place = (d: string, more: string[][] = [["t", "stream"]]) => ({
  id: d.replace(/-/g, "").padEnd(64, "0"),
  pubkey: relayKey,
  sig: "",
  created_at: 5,
  kind: 39000,
  content: "",
  tags: [["d", d], ["name", d.slice(0, 4)], ["private"], ...more],
});
const places = [
  place(home),
  place(away),
  place(dm, [["t", "dm"]]),
  place(huddle, [
    ["t", "stream"],
    ["about", `Buzz Huddle (buzz.huddles/v1)\nparent:${home}`],
  ]),
];

function session(publish: () => Promise<string>, heads: object[] = []) {
  const sign = vi.fn(async (template: object) => ({
    ...template,
    id: "f".repeat(64),
    pubkey: viewer,
    sig: "",
  }));
  const read = vi.fn(
    async (filters: { kinds?: number[]; "#d"?: string[] }[]) =>
      filters[0]?.kinds?.includes(39000)
        ? places.filter((event) =>
            filters[0]?.["#d"]?.includes(event.tags[0]?.[1] ?? ""),
          )
        : heads,
  );
  return {
    sign,
    read,
    session: {
      viewer,
      relayAuthor: relayKey,
      snapshotRead: read,
      configArtifactWriter: { sign, publish: vi.fn(publish) },
      profiles: { snapshot: () => new Map([[riley, { name: "Riley" }]]) },
    } as unknown as RelaySession,
  };
}
const tagsOf = (sign: ReturnType<typeof session>["sign"], call: number) =>
  (sign.mock.calls[call]?.[0] as unknown as { tags: string[][] } | undefined)
    ?.tags ?? [];

it("creates a task in its home, then edits only the revision it opened", async () => {
  const { session: relay, sign } = session(async () => "");
  const created = await saveTask(relay, relay, fields, {
    op: "create",
    home,
    id,
  });
  expect(created.status).toBe("saved");
  expect(tagsOf(sign, 0)).toContainEqual(["op", "create"]);
  expect(tagsOf(sign, 0)).toContainEqual(["h", home]);
  expect(tagsOf(sign, 0).some(([name]) => name === "prev")).toBe(false);
  if (created.status !== "saved") return;
  await saveTask(
    relay,
    relay,
    { ...fields, status: "done" },
    { op: "update", base: created.task },
  );
  expect(tagsOf(sign, 1)).toContainEqual(["op", "update"]);
  expect(tagsOf(sign, 1)).toContainEqual(["prev", created.task.revision]);
  expect(tagsOf(sign, 1)).toContainEqual(["h", home]);
});

it("moves a task as a revision whose home is the new place", async () => {
  const { session: relay, sign } = session(async () => "");
  const base = taskOf(head("d".repeat(64))) as Task;
  const moved = await saveTask(relay, relay, fields, {
    op: "move",
    base,
    home: away,
  });
  expect(moved.status === "saved" && moved.task.home).toBe(away);
  expect(tagsOf(sign, 0)).toContainEqual(["op", "move"]);
  expect(tagsOf(sign, 0)).toContainEqual(["h", away]);
  expect(tagsOf(sign, 0)).toContainEqual(["prev", base.revision]);
});

it("reports someone else's save as a conflict with their version", async () => {
  const theirs = head("c".repeat(64), { description: "Theirs." });
  const { session: relay } = session(async () => {
    throw new PublishRejected("rejected", "conflict: stale prev");
  }, [theirs]);
  const base = taskOf(head("d".repeat(64))) as Task;
  const result = await saveTask(relay, relay, fields, { op: "update", base });
  expect(result).toEqual({ status: "conflict", current: taskOf(theirs) });
});

it("confirms an uncertain save from the head, else says it failed", async () => {
  const base = taskOf(head("d".repeat(64))) as Task;
  const landed = session(async () => {
    throw new Error("socket closed");
  }, [head("f".repeat(64))]);
  expect(
    (
      await saveTask(landed.session, landed.session, fields, {
        op: "update",
        base,
      })
    ).status,
  ).toBe("saved");
  const lost = session(async () => {
    throw new Error("socket closed");
  }, [head("d".repeat(64))]);
  await expect(
    saveTask(lost.session, lost.session, fields, { op: "update", base }),
  ).rejects.toThrow("Couldn’t save the task. Try again.");
});

it("says why the relay refused, for an edit and for a move", async () => {
  const base = taskOf(head("d".repeat(64))) as Task;
  const refused = session(async () => {
    throw new PublishRejected("rejected", "restricted: not a member");
  });
  await expect(
    saveTask(refused.session, refused.session, fields, { op: "update", base }),
  ).rejects.toThrow("You can only view tasks here.");
  await expect(
    saveTask(refused.session, refused.session, fields, {
      op: "move",
      base,
      home: away,
    }),
  ).rejects.toThrow("between places you can post in");
});

const refusedWith = (reason: string) =>
  session(async () => {
    throw new PublishRejected("rejected", reason);
  }).session;

it("says each relay reason in plain words, naming people it knows", async () => {
  const base = taskOf(head("d".repeat(64))) as Task;
  const save = (reason: string) =>
    saveTask(refusedWith(reason), refusedWith(reason), fields, {
      op: "update",
      base,
    });
  await expect(
    save(
      `invalid: assignee-unreadable:${riley} — an assignee can't see this artifact`,
    ),
  ).rejects.toThrow(
    "Riley can’t see #2222, so they can’t be assigned. Nothing was saved.",
  );
  await expect(
    save(`invalid: assignee-unreadable:${riley},${"9".repeat(64)} — x`),
  ).rejects.toThrow(
    "One of the people assigned can’t see #2222. Nothing was saved.",
  );
  // A place it can't read is described, not named.
  const unread = taskOf(head("d".repeat(64), {}, dm.replace("4444", "6666")));
  await expect(
    saveTask(
      refusedWith(`invalid: assignee-unreadable:${riley} — x`),
      refusedWith(""),
      fields,
      { op: "update", base: unread as Task },
    ),
  ).rejects.toThrow(
    "Riley can’t see where this task lives, so they can’t be assigned. Nothing was saved.",
  );
  await expect(
    save(`invalid: assignee-agent:${riley} — an agent can't be an assignee`),
  ).rejects.toThrow(
    "Only people can be assigned, and Riley is an agent. Nothing was saved.",
  );
  await expect(
    save("invalid: too-many-assignees: — a revision names at most 4 assignees"),
  ).rejects.toThrow("A task can have up to 4 people assigned.");
  await expect(
    save("invalid: signer-agent: — an agent can't sign an artifact"),
  ).rejects.toThrow("Only a person can save a task, not an agent.");
  // A code it doesn't know, or text with no code: a plain line, never the
  // relay's words or a key. Those go to the log, and to an agent's tool.
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const reason of [
    `invalid: something-new:${riley} — artifact jargon`,
    "invalid: bad artifact tag",
  ]) {
    const error = await save(reason).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TaskRefused);
    expect((error as TaskRefused).message).toBe(
      "This change isn’t allowed. Nothing was saved.",
    );
    expect((error as TaskRefused).relay).toBe(reason);
    expect(warn).toHaveBeenLastCalledWith(
      "The relay refused a task save:",
      reason,
    );
  }
  warn.mockRestore();
});

it("resends once with the creator the relay keeps", async () => {
  const forged = head("d".repeat(64));
  forged.tags.push(["creator", "9".repeat(64)]);
  const base = taskOf(forged) as Task;
  let calls = 0;
  const { session: relay, sign } = session(async () => {
    calls++;
    if (calls === 1)
      throw new PublishRejected(
        "rejected",
        `invalid: creator-changed:${riley} — creator cannot change; resend with the named creator`,
      );
    return "";
  });
  const saved = await saveTask(relay, relay, fields, { op: "update", base });
  expect(saved.status).toBe("saved");
  expect(tagsOf(sign, 0)).toContainEqual(["creator", "9".repeat(64)]);
  expect(tagsOf(sign, 1)).toContainEqual(["creator", riley]);
  expect(saved.status === "saved" && saved.task.creator).toBe(riley);

  // "none": the relay knows no creator, so the resend names none.
  calls = 0;
  const unknown = session(async () => {
    calls++;
    if (calls === 1)
      throw new PublishRejected(
        "rejected",
        "invalid: creator-changed:none — creator cannot change",
      );
    return "";
  });
  await saveTask(unknown.session, unknown.session, fields, {
    op: "update",
    base,
  });
  expect(tagsOf(unknown.sign, 1).some(([name]) => name === "creator")).toBe(
    false,
  );
});

it("resends a creator only once", async () => {
  const base = taskOf(head("d".repeat(64))) as Task;
  let calls = 0;
  const relay = session(async () => {
    calls++;
    throw new PublishRejected(
      "rejected",
      `invalid: creator-changed:${riley} — creator cannot change`,
    );
  }).session;
  await expect(
    saveTask(relay, relay, fields, { op: "update", base }),
  ).rejects.toThrow("This change isn’t allowed. Nothing was saved.");
  expect(calls).toBe(2);
});

it("finds a create that landed unseen instead of making a second task", async () => {
  const { session: relay, sign } = session(async () => {
    throw new Error("socket closed");
  }, [head("f".repeat(64))]);
  const result = await saveTask(relay, relay, fields, {
    op: "create",
    home,
    id,
  });
  expect(result.status).toBe("saved");
  expect(tagsOf(sign, 0)).toContainEqual(["d", id]);
});

it("finds a moved task when its old home no longer has it", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([head("d".repeat(64), {}, away)]);
  const relay = { snapshotRead: read } as unknown as RelaySession;
  const task = await readTask(relay, id, AbortSignal.timeout(1000), home);
  expect(task?.home).toBe(away);
  expect(read.mock.calls[0]?.[0]).toEqual([
    expect.objectContaining({ "#h": [home], "#d": [id] }),
  ]);
  expect(read.mock.calls[1]?.[0]?.[0]).not.toHaveProperty("#h");
});

it("never creates or moves a task into a DM or a huddle, whoever calls", async () => {
  const { session: relay, sign } = session(async () => "");
  const base = taskOf(head("d".repeat(64))) as Task;
  for (const place of [dm, huddle]) {
    await expect(
      saveTask(relay, relay, fields, { op: "create", home: place, id }),
    ).rejects.toThrow(NOT_A_TASK_PLACE);
    await expect(
      saveTask(relay, relay, fields, { op: "move", base, home: place }),
    ).rejects.toThrow(NOT_A_TASK_PLACE);
  }
  await expect(
    saveTask(relay, relay, fields, {
      op: "create",
      home: "66666666-6666-4666-8666-666666666666",
      id,
    }),
  ).rejects.toThrow("You can’t see that place.");
  expect(sign).not.toHaveBeenCalled();
});

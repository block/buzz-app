import { expect, it, vi } from "vitest";
import { PublishRejected } from "../../features/relay/outbox";
import type { RelaySession } from "../../features/relay/session";
import { TASK_TYPE } from "./model";
import { addTaskTools } from "./tools";

const viewer = "a".repeat(64);
const agent = "9".repeat(64);
const person = "b".repeat(64);
const stranger = "8".repeat(64);
const leo = "7".repeat(64);
const relay = "e".repeat(64);
const id = "11111111-1111-4111-8111-111111111111";
const chat = "22222222-2222-4222-8222-222222222222";
const home = "33333333-3333-4333-8333-333333333333";
/** A private channel the owner is in and the agent isn't. */
const secret = "55555555-5555-4555-8555-555555555555";
/** A channel Riley isn't in. */
const lobby = "77777777-7777-4777-8777-777777777777";
/** A project Leo is in, a channel in it, and one shut off from it. */
const project = "88888888-8888-4888-8888-888888888888";
const filed = "99999999-9999-4999-8999-999999999999";
const shut = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** A DM and a huddle, where no task can live. */
const dm = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const huddle = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type Event = {
  id: string;
  pubkey: string;
  kind: number;
  content: string;
  tags: string[][];
};
type Filter = Record<string, unknown>;

const head = (
  revision: string,
  tags: string[][] = [],
  extra: { d?: string; title?: string; home?: string } = {},
): Event => ({
  id: revision,
  pubkey: viewer,
  kind: 45010,
  content: JSON.stringify({ version: 3 }),
  tags: [
    ["d", extra.d ?? id],
    ["h", extra.home ?? home],
    ["type", TASK_TYPE],
    ["title", extra.title ?? "Fix the header"],
    ["creator", viewer],
    ...tags,
  ],
});

const place = (d: string, name: string, more: string[][] = []): Event => ({
  id: d.replace(/-/g, "").padEnd(64, "0"),
  pubkey: relay,
  kind: 39000,
  content: "",
  tags: [
    ["d", d],
    ["name", name],
    ["t", more.find(([key]) => key === "t")?.[1] ?? "stream"],
    ["private"],
    ...more.filter(([key]) => key !== "t"),
  ],
});
const roster = (d: string, members: string[]): Event => ({
  ...place(d, ""),
  kind: 39002,
  tags: [["d", d], ...members.map((key) => ["p", key])],
});

/** Answers `filters` from `events` the way the relay filters them. */
function answer(events: Event[], filters: Filter[]) {
  const filter = filters[0] ?? {};
  return events.filter((event) => {
    if (!(filter.kinds as number[]).includes(event.kind)) return false;
    for (const [key, values] of Object.entries(filter))
      if (
        key.startsWith("#") &&
        !event.tags.some(
          ([name, value]) =>
            name === key.slice(1) && (values as string[]).includes(value ?? ""),
        )
      )
        return false;
    if (filter.unassigned && event.tags.some(([name]) => name === "assignee"))
      return false;
    if (
      typeof filter.within === "string" &&
      !event.tags.some(
        ([name, value]) => name === "h" && value === filter.within,
      )
    )
      return false;
    return true;
  });
}

/** Who the relay says can read each place: its own judgment, including
 * project members let into a filed channel, never the rosters'. */
const canRead: Record<string, string[]> = {
  [home]: [viewer, person],
  [chat]: [viewer, person],
  [secret]: [viewer],
  [lobby]: [viewer, leo],
  [project]: [viewer, leo],
  [filed]: [viewer, leo],
  [shut]: [viewer],
};

type Signed = { kind: number; content: string; tags: string[][] };

/** The owner can read `heads` and every place; the agent can read every
 * place but `secret`, and what lives there. */
function setup(
  publish: () => Promise<string>,
  heads: () => Event[],
  where = chat,
  readers: RelaySession["channelReaders"] = async (channel, pubkeys) =>
    new Map(
      pubkeys.map((key) => [key, canRead[channel]?.includes(key) ?? false]),
    ),
) {
  const signed: Signed[] = [];
  const posted: Signed[] = [];
  const places = () => [
    place(home, "design"),
    place(chat, "random"),
    place(secret, "payroll"),
    place(lobby, "lobby"),
    roster(lobby, [viewer, leo]),
    roster(home, [viewer, person]),
    roster(chat, [viewer, person]),
    roster(secret, [viewer]),
    place(project, "Payments"),
    place(filed, "billing", [["parent", project]]),
    place(shut, "payroll-review", [
      ["parent", project],
      ["parent_access", "none"],
    ]),
    roster(project, [viewer, leo]),
    roster(filed, [viewer]),
    roster(shut, [viewer]),
    place(dm, "", [["t", "dm"]]),
    place(huddle, "huddle-cccccccc", [
      ["about", `Buzz Huddle (buzz.huddles/v1)\nparent:${home}`],
    ]),
  ];
  const visible = (event: Event) =>
    !event.tags.some(
      ([name, value]) => (name === "h" || name === "d") && value === secret,
    );
  const session = {
    viewer,
    relayAuthor: relay,
    profiles: {
      ensure: async () => {},
      snapshot: () =>
        new Map([
          [agent, { name: "Fizz", isAgent: true }],
          [person, { name: "Riley" }],
          [leo, { name: "Leo" }],
        ]),
    },
    snapshotRead: vi.fn(async (filters: Filter[]) =>
      answer([...heads(), ...places()], filters),
    ),
    channelReaders: readers,
    configArtifactWriter: {
      sign: vi.fn(async (template: Signed) => {
        signed.push(template);
        return {
          ...template,
          id: `${signed.length}`.padStart(64, "f"),
          pubkey: viewer,
          sig: "",
        };
      }),
      publish: vi.fn(publish),
    },
  } as unknown as RelaySession;
  const client = {
    key: agent,
    pubkey: agent,
    signal: new AbortController().signal,
    query: vi.fn(async (filters: Filter[]) =>
      answer([...heads(), ...places()].filter(visible), filters),
    ),
    publish: vi.fn(async (event: Signed) => {
      if (event.tags.some(([name, value]) => name === "h" && !value))
        throw new Error("no conversation");
      posted.push(event);
      return { ...event, id: "1".repeat(64), pubkey: agent };
    }),
  };
  const tools = new Map<
    string,
    (args: Record<string, unknown>) => Promise<unknown>
  >();
  addTaskTools({
    relay: () => ({ snapshot: () => ({ status: "ready", session }) }) as never,
    addTool: (tool) => {
      tools.set(tool.name, (args) =>
        tool.call(client as never, { channel: where } as never, args),
      );
    },
  });
  const call = (name: string, args: Record<string, unknown>) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`no ${name}`);
    return tool(args) as Promise<string>;
  };
  return { call, signed, posted, client };
}
const artifacts = (signed: Signed[]) =>
  signed.filter((event) => event.kind === 45010);
const tagOf = (event: Signed | undefined, name: string) =>
  event?.tags.find((tag) => tag[0] === name)?.[1];
const assignees = (event: Signed | undefined) =>
  event?.tags.flatMap(([name, value]) => (name === "assignee" ? [value] : []));

it("offers exactly find, create, update and comment", () => {
  const names: string[] = [];
  addTaskTools({
    relay: () => undefined as never,
    addTool: (tool) => void names.push(tool.name),
  });
  expect(names).toEqual([
    "tasks_find",
    "tasks_create",
    "tasks_update",
    "tasks_comment",
  ]);
});

it("creates in the named place as its owner, via the agent, posting nothing", async () => {
  const { call, signed, posted } = setup(
    async () => "",
    () => [],
  );
  const reply = await call("tasks_create", {
    title: "Fix the header",
    place: home,
    images: ["https://example.org/a.png"],
  });
  expect(reply).toContain("Created task");
  const [task, link] = artifacts(signed);
  expect(task?.tags).toContainEqual(["h", home]);
  expect(task?.tags).toContainEqual(["creator", viewer]);
  expect(task?.tags).toContainEqual(["via", agent]);
  expect(task?.tags).toContainEqual(["status", "todo"]);
  expect(JSON.parse(task?.content ?? "")).toMatchObject({
    images: [{ url: "https://example.org/a.png" }],
  });
  // The link lives with the chat, so only its readers learn of it.
  expect(tagOf(link, "type")).toBe("buzz.task-link");
  expect(link?.tags).toContainEqual(["h", chat]);
  expect(signed.every((event) => event.kind === 45010)).toBe(true);
  expect(posted).toHaveLength(0);
});

it("never puts a task in a DM or a huddle", async () => {
  // Talking in a DM, the agent is asked for a place instead.
  const { call, signed } = setup(
    async () => "",
    () => [head("d".repeat(64))],
    dm,
  );
  await expect(call("tasks_create", { title: "Fix it" })).rejects.toThrow(
    "never a DM or a huddle. Ask which place it should go in",
  );
  await expect(
    call("tasks_create", { title: "Fix it", place: huddle }),
  ).rejects.toThrow("never a DM or a huddle");
  await expect(call("tasks_update", { id, place: dm })).rejects.toThrow(
    "never a DM or a huddle",
  );
  expect(signed).toHaveLength(0);
});

it("returns a clear match instead of creating a duplicate", async () => {
  const { call, signed } = setup(
    async () => "",
    () => [head("d".repeat(64), [["status", "todo"]])],
  );
  const reply = await call("tasks_create", {
    title: "Fix the header",
    place: home,
  });
  expect(reply).toContain(`Not created: open task ${id}`);
  expect(signed).toHaveLength(0);
});

it("leaves a possible match for the person, then creates when told", async () => {
  const { call, signed } = setup(
    async () => "",
    () => [head("d".repeat(64), [["status", "todo"]])],
  );
  const args = { title: "Fix the header spacing on mobile", place: home };
  expect(await call("tasks_create", args)).toContain("Not created yet");
  expect(signed).toHaveLength(0);
  await call("tasks_create", { ...args, new_anyway: true, link: false });
  expect(artifacts(signed)).toHaveLength(1);
});

it("asks the relay for what's mine and what nobody has taken", async () => {
  const other = "44444444-4444-4444-8444-444444444444";
  const { call, client } = setup(
    async () => "",
    () => [
      head("d".repeat(64), [
        ["status", "todo"],
        ["assignee", viewer],
      ]),
      head("c".repeat(64), [["status", "in_progress"]], {
        d: other,
        title: "Nobody's",
      }),
    ],
  );
  const mine = await call("tasks_find", { assignee: "me" });
  expect(mine).toContain(id);
  expect(mine).not.toContain(other);
  expect(client.query).toHaveBeenLastCalledWith([
    expect.objectContaining({
      "#assignee": [viewer],
      "#status": ["todo", "in_progress"],
    }),
  ]);
  const nobody = await call("tasks_find", { assignee: "nobody" });
  expect(nobody).toContain(other);
  expect(nobody).not.toContain(id);
  expect(client.query).toHaveBeenLastCalledWith([
    expect.objectContaining({ unassigned: true }),
  ]);
});

it("says when a read may have missed tasks", async () => {
  const many = Array.from({ length: 500 }, (_, at) =>
    head(`${at}`.padStart(64, "0"), [["status", "todo"]], {
      d: `11111111-1111-4111-8111-${`${at}`.padStart(12, "0")}`,
    }),
  );
  const { call } = setup(
    async () => "",
    () => many,
  );
  expect(await call("tasks_find", {})).toContain("may not be all of them");
});

it("comments the evidence as the agent before the task closes", async () => {
  const { call, signed, posted } = setup(
    async () => "",
    () => [head("d".repeat(64), [["status", "todo"]])],
  );
  await expect(call("tasks_update", { id, status: "done" })).rejects.toThrow(
    "needs evidence",
  );
  expect(signed).toHaveLength(0);
  await call("tasks_update", { id, status: "done", evidence: "Merged #12" });
  expect(posted.map((event) => event.kind)).toEqual([9007, 9]);
  expect(posted[1]?.content).toBe("Done: Merged #12");
  expect(tagOf(signed[0], "status")).toBe("done");
});

it("leaves the task open when the evidence comment fails", async () => {
  const { call, signed, client } = setup(
    async () => "",
    () => [head("d".repeat(64), [["status", "todo"]])],
  );
  client.publish.mockRejectedValueOnce(new Error("restricted: read-only"));
  await expect(
    call("tasks_update", { id, status: "cancelled", evidence: "Duplicate" }),
  ).rejects.toThrow("You can’t comment on this task: restricted: read-only");
  expect(signed).toHaveLength(0);
});

it("says plainly when the owner may not save, and tries nothing else", async () => {
  const { call, signed, client } = setup(
    async () => {
      throw new PublishRejected("rejected", "restricted: read-only");
    },
    () => [head("d".repeat(64), [["status", "todo"]])],
  );
  await expect(call("tasks_update", { id, title: "New" })).rejects.toThrow(
    "You can only view tasks here.",
  );
  expect(signed).toHaveLength(1);
  expect(client.publish).not.toHaveBeenCalled();
});

it("assigns the person it works for when work starts", async () => {
  const { call, signed } = setup(
    async () => "",
    () => [head("d".repeat(64), [["status", "todo"]])],
  );
  await call("tasks_update", { id, status: "in_progress" });
  expect(tagOf(signed[0], "status")).toBe("in_progress");
  expect(assignees(signed[0])).toEqual([viewer]);
});

it("assigns only known people who can see the task", async () => {
  const { call, signed } = setup(
    async () => "",
    () => [head("d".repeat(64))],
  );
  await expect(
    call("tasks_update", { id, assignees: [person, agent] }),
  ).rejects.toThrow("never agents");
  await expect(
    call("tasks_update", { id, assignees: [stranger] }),
  ).rejects.toThrow("Couldn't find a person");
  expect(signed).toHaveLength(0);
  await call("tasks_update", { id, assignees: [person] });
  expect(assignees(signed[0])).toEqual([person]);
});

it("refuses an assignee who can't see the task", async () => {
  const { call, signed } = setup(
    async () => "",
    () => [head("d".repeat(64))],
  );
  await expect(
    call("tasks_update", { id, assignees: [person, leo] }),
  ).rejects.toThrow(
    "Leo can't see #design, so they can't be assigned. Nothing changed.",
  );
  expect(signed).toHaveLength(0);
});

it("goes by the relay's answer of who can see a place, not its member lists", async () => {
  const there = (home: string) => () => [head("d".repeat(64), [], { home })];
  // Filed in the project as usual: Leo, only in the project, can see it.
  const open = setup(async () => "", there(filed));
  await open.call("tasks_update", { id, assignees: [leo] });
  expect(assignees(open.signed[0])).toEqual([leo]);
  // Project access off: he can't.
  const closed = setup(async () => "", there(shut));
  await expect(
    closed.call("tasks_update", { id, assignees: [leo] }),
  ).rejects.toThrow("Leo can't see #payroll-review");
  expect(closed.signed).toHaveLength(0);
});

it("keeps someone on a move when the relay says they can see the destination", async () => {
  // Leo isn't on #billing's member list, but reads it through Payments.
  const { call, signed } = setup(
    async () => "",
    () => [head("d".repeat(64), [["assignee", leo]], { home: lobby })],
  );
  const preview = await call("tasks_update", { id, place: filed });
  expect(preview).not.toContain("unassigned");
  const confirm = /confirm "([^"]+)"/.exec(preview)?.[1];
  await call("tasks_update", { id, place: filed, confirm });
  expect(assignees(signed[0])).toEqual([leo]);
});

it("flags and unassigns nobody when the relay can't say who can see a place", async () => {
  const unknown = async () => {
    throw new Error("not-allowed");
  };
  const { call, signed } = setup(
    async () => "",
    () => [head("d".repeat(64), [["assignee", leo]], { home: filed })],
    chat,
    unknown,
  );
  const preview = await call("tasks_update", { id, place: shut });
  expect(preview).not.toContain("Leo");
  const confirm = /confirm "([^"]+)"/.exec(preview)?.[1];
  await call("tasks_update", { id, place: shut, confirm });
  expect(assignees(signed[0])).toEqual([leo]);
  // An edit isn't refused either; the relay's own check decides the save.
  await call("tasks_update", { id, assignees: [leo, person] });
  expect(assignees(signed[1])).toEqual([leo, person]);
});

it("names a project member a move shuts out", async () => {
  const { call, signed } = setup(
    async () => "",
    () => [head("d".repeat(64), [["assignee", leo]], { home: filed })],
  );
  const preview = await call("tasks_update", { id, place: shut });
  expect(preview).toContain(
    "Leo can't see #payroll-review and will be unassigned.",
  );
  expect(preview).toContain("Payments");
  const confirm = /confirm "([^"]+)"/.exec(preview)?.[1];
  await call("tasks_update", { id, place: shut, confirm });
  expect(assignees(signed[0])).toEqual([]);
});

it("says the relay's reason in plain words when it refuses an assignee anyway", async () => {
  const { call } = setup(
    async () => {
      throw new PublishRejected(
        "rejected",
        `invalid: assignee-unreadable:${person} — an assignee can't see this artifact`,
      );
    },
    () => [head("d".repeat(64))],
  );
  await expect(
    call("tasks_update", { id, assignees: [person] }),
  ).rejects.toThrow(
    `Riley can’t see #design, so they can’t be assigned. Nothing was saved. The relay said: invalid: assignee-unreadable:${person} — an assignee can't see this artifact`,
  );
});

it("keeps someone assigned who lost access when an edit adds nobody new", async () => {
  const { call, signed } = setup(
    async () => "",
    () => [head("d".repeat(64), [["assignee", leo]])],
  );
  await call("tasks_update", { id, assignees: [leo, person] });
  expect(assignees(signed[0])).toEqual([leo, person]);
});

it("previews a move, by place, and moves only with its confirm", async () => {
  const { call, signed } = setup(
    async () => "",
    () => [head("d".repeat(64), [["assignee", person]])],
  );
  await expect(
    call("tasks_update", { id, place: chat, title: "Also this" }),
  ).rejects.toThrow("Move a task on its own");
  const preview = await call("tasks_update", { id, place: chat });
  expect(preview).toContain("Not moved yet");
  expect(preview).toContain("#random");
  expect(preview).not.toContain("Riley");
  expect(signed).toHaveLength(0);
  await expect(
    call("tasks_update", { id, place: chat, confirm: "made-up" }),
  ).rejects.toThrow("isn't from a preview");
  const confirm = /confirm "([^"]+)"/.exec(preview)?.[1];
  await call("tasks_update", { id, place: chat, confirm });
  expect(signed[0]?.tags).toContainEqual(["op", "move"]);
  expect(signed[0]?.tags).toContainEqual(["h", chat]);
  expect(assignees(signed[0])).toEqual([person]);
  // A confirm is good once.
  await expect(
    call("tasks_update", { id, place: chat, confirm }),
  ).rejects.toThrow();
});

it("names an assignee a move leaves behind, and unassigns them", async () => {
  const { call, signed } = setup(
    async () => "",
    () => [
      head("d".repeat(64), [
        ["assignee", person],
        ["assignee", viewer],
      ]),
    ],
  );
  const preview = await call("tasks_update", { id, place: lobby });
  expect(preview).toContain("Riley can't see #lobby and will be unassigned.");
  const confirm = /confirm "([^"]+)"/.exec(preview)?.[1];
  await call("tasks_update", { id, place: lobby, confirm });
  expect(assignees(signed[0])).toEqual([viewer]);
});

it("keeps an agent out of a private channel its owner is in", async () => {
  const hidden = "66666666-6666-4666-8666-666666666666";
  const { call, signed, posted } = setup(
    async () => "",
    () => [
      head("d".repeat(64), [["status", "todo"]]),
      head("c".repeat(64), [["status", "todo"]], {
        d: hidden,
        home: secret,
        title: "Payroll export",
      }),
    ],
  );
  // It can't find tasks there,
  expect(await call("tasks_find", {})).not.toContain(hidden);
  await expect(call("tasks_find", { id: hidden })).rejects.toThrow("No task");
  // edit or comment on them,
  await expect(
    call("tasks_update", { id: hidden, title: "Mine now" }),
  ).rejects.toThrow("No task");
  await expect(
    call("tasks_comment", { id: hidden, text: "Seen it" }),
  ).rejects.toThrow("No task");
  // or move or create tasks there.
  await expect(call("tasks_update", { id, place: secret })).rejects.toThrow(
    "can't see that place",
  );
  await expect(
    call("tasks_create", { title: "Payroll", place: secret }),
  ).rejects.toThrow("can't see that place");
  expect(signed).toHaveLength(0);
  expect(posted).toHaveLength(0);
});

it("reapplies an update over someone else's newer save", async () => {
  let current = head("d".repeat(64), [["status", "todo"]]);
  let calls = 0;
  const { call, signed } = setup(
    async () => {
      if (calls++ === 0) {
        current = head("c".repeat(64), [["status", "todo"]], {
          title: "Newer",
        });
        throw new PublishRejected("rejected", "conflict: stale prev");
      }
      return "";
    },
    () => [current],
  );
  await call("tasks_update", { id, status: "in_progress" });
  expect(signed[1]?.tags).toContainEqual(["prev", "c".repeat(64)]);
  expect(signed[1]?.tags).toContainEqual(["title", "Newer"]);
  expect(tagOf(signed[1], "status")).toBe("in_progress");
});

it("never retries as the owner: a task moved where the agent can't read stays unclosed", async () => {
  let current = head("d".repeat(64), [["status", "todo"]], {
    title: "Launch checklist",
  });
  let calls = 0;
  const { call, signed } = setup(
    async () => {
      if (calls++ === 0) {
        // Moved into an owner-only chat while the agent was closing it.
        current = head("c".repeat(64), [["status", "todo"]], {
          home: secret,
          title: "Launch checklist",
        });
        throw new PublishRejected("rejected", "conflict: stale prev");
      }
      return "";
    },
    () => [current],
  );
  const closing = call("tasks_update", {
    id,
    status: "done",
    evidence: "Shipped",
  });
  await expect(closing).rejects.toThrow("Nothing was saved");
  await expect(closing).rejects.not.toThrow("Launch checklist");
  expect(artifacts(signed)).toHaveLength(1);
});

it("stops when a task it can still read moved during its change", async () => {
  let current = head("d".repeat(64), [["status", "todo"]]);
  let calls = 0;
  const { call, signed } = setup(
    async () => {
      if (calls++ === 0) {
        current = head("c".repeat(64), [["status", "todo"]], { home: chat });
        throw new PublishRejected("rejected", "conflict: stale prev");
      }
      return "";
    },
    () => [current],
  );
  await expect(
    call("tasks_update", { id, status: "in_progress" }),
  ).rejects.toThrow("Someone moved this task");
  expect(artifacts(signed)).toHaveLength(1);
});

it("tells the agent which id to check after an unclear create", async () => {
  const { call, signed } = setup(
    async () => {
      throw new Error("network");
    },
    () => [],
  );
  const failed = call("tasks_create", { title: "Fix", link: false });
  await expect(failed).rejects.toThrow(/saved as task [0-9a-f-]{36}/);
  const made = tagOf(signed[0], "d");
  await expect(failed).rejects.toThrow(made);
});

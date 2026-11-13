import type { LiveListener } from "../../features/relay/incoming";
import { describeTool } from "../../buzz-mcp/session-tools";
// @vitest-environment jsdom
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { ReadPullStatus } from "./pull-facts";
import { ReviewSubmissions } from "./ReviewSubmissions";
import { useSubmissionUpdates } from "./submission-updates";
import { loadConfigurations, type SavedReviewConfig } from "./configuration";
import {
  loadSubmissions,
  applyReviewReports,
  deleteSubmission,
  remindSubmission,
  submitReview,
  type SavedSubmission,
} from "./submissions";

vi.mock("./configuration", async (original) => ({
  ...(await original<typeof import("./configuration")>()),
  loadConfigurations: vi.fn(),
}));
vi.mock("./submissions", async (original) => ({
  ...(await original<typeof import("./submissions")>()),
  loadSubmissions: vi.fn(),
  deleteSubmission: vi.fn(),
  remindSubmission: vi.fn(),
  submitReview: vi.fn(),
}));
afterEach(cleanup);
const configuration: SavedReviewConfig = {
  revision: "b".repeat(64),
  artifactId: "config",
  config: {
    version: 1,
    repository: "example-org/project",
    reminderMinutes: 15,
    lanes: [
      {
        id: "ui",
        name: "UI",
        instructions: "Check keyboard access.",
        reviewers: ["a".repeat(64)],
      },
    ],
  },
};
const record: SavedSubmission = {
  artifactId: "submission",
  revision: "c".repeat(64),
  value: {
    version: 2,
    pr: 42,
    config: configuration.config,
    configRevision: configuration.revision,
    submitter: "d".repeat(64),
    device: "device",
    threads: [{ id: "e".repeat(64), delivered: true }],
  },
};
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(loadConfigurations).mockResolvedValue({
    rows: [configuration],
    unreadable: 0,
    truncated: false,
  });
  vi.mocked(loadSubmissions).mockResolvedValue({ rows: [], warning: "" });
  vi.mocked(submitReview).mockImplementation(
    async (_s, _c, _config, _pr, _r, _signal, progress, _resume, facts) => {
      if (typeof facts === "function") await facts();
      progress({ ...record, value: { ...record.value, threads: [{}] } });
      progress(record);
      return record;
    },
  );
});
function fixture(
  mode: "submit" | "all" = "submit",
  viewer = record.value.submitter,
  readStatus: ReadPullStatus = vi.fn(async () => "Open" as const),
  readable = true,
  initialSelection: string | null = record.artifactId,
) {
  const agents = [{ pubkey: "a".repeat(64), name: "UI Reviewer" }];
  const choices = {
    identities: agents,
    selectable: agents,
    pending: false,
    archives: { status: "ready" },
  };
  const listeners = new Set<LiveListener>();
  const session = {
    subscribeLive: (listener: LiveListener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    viewer,
    thread: vi.fn(() => ({
      refresh: async () => {},
      dispose: vi.fn(),
      snapshot: () => ({
        status: "ready",
        replies: [],
        root: {
          id: "e".repeat(64),
          channelId: "channel",
          content: "The complete latest message",
          createdAt: 100,
          authorId: "a".repeat(64),
          mentions: [],
        },
      }),
    })),
    agentChoices: {
      subscribe: () => () => {},
      snapshot: () => choices,
      retain: () => () => {},
      ensure() {},
    },
  } as unknown as RelaySession;
  const readPull = vi.fn(async () => ({
    repository: "example-org/project",
    pr: 42,
    title: "UI change",
    labels: ["ui"],
    changedFiles: 1,
    paths: ["ui.tsx"],
    head: "a".repeat(40),
    base: "b".repeat(40),
  }));
  const onOpenThread = vi.fn(async () => {});
  const onOpenMessage = vi.fn(async () => {});
  const editing = vi.fn();
  let selection = initialSelection;
  let ready = readable;
  const onOpenSubmission = vi.fn(async (_channel: string, id?: string) => {
    selection = id ?? null;
    view.rerender(content(ready));
  });
  const content = (ready: boolean) => (
    <>
      <UpdateCount session={session} enabled={ready && mode === "all"} />
      <ReviewSubmissions
        readable={ready}
        session={session}
        mode={mode}
        submission={mode === "all" ? (selection ?? undefined) : undefined}
        onOpenSubmission={onOpenSubmission}
        channel="channel"
        writable
        onEditingChange={editing}
        onOpenThread={onOpenThread}
        onOpenMessage={onOpenMessage}
        readPull={readPull}
        readStatus={readStatus}
        describeTool={describeTool}
      />
    </>
  );
  const view = render(content(readable));
  return {
    ...view,
    setReadable: (value: boolean) => {
      ready = value;
      view.rerender(content(ready));
    },
    select: (id: string | null) => {
      selection = id;
      view.rerender(content(ready));
    },
    onOpenSubmission,
    emit: (events: Parameters<LiveListener>[0]["events"]) =>
      act(() => {
        for (const listener of listeners) listener({ events });
      }),
    session,
    readPull,
    readStatus,
    onOpenThread,
    onOpenMessage,
    editing,
    user: userEvent.setup(),
  };
}
function UpdateCount({
  session,
  enabled,
}: {
  session: RelaySession;
  enabled: boolean;
}) {
  const updates = useSubmissionUpdates(session, "channel", enabled);
  return (
    <span data-testid="unseen-updates">
      {updates.rows.filter(updates.store.unread).length}
    </span>
  );
}
async function enter(
  user: ReturnType<typeof userEvent.setup>,
  url = "https://github.com/example-org/project/pull/42",
) {
  await user.type(screen.getByRole("textbox", { name: "GitHub PR URL" }), url);
  await user.click(screen.getByRole("button", { name: "Submit PR" }));
}
it("submits a URL in one action and shows assigned reviewers and working thread controls", async () => {
  const test = fixture();
  await enter(test.user);
  expect((await screen.findByRole("status")).textContent).toContain(
    "Submitted — reviewers assigned",
  );
  expect(test.readPull).toHaveBeenCalledWith(
    "example-org/project",
    42,
    expect.any(AbortSignal),
  );
  const result = screen.getByRole("region", { name: "Submission result" });
  expect(within(result).getByText("UI Reviewer")).toBeTruthy();
  await test.user.click(
    within(result).getByRole("button", { name: "Open UI thread" }),
  );
  expect(test.onOpenThread).toHaveBeenCalledWith("channel", "e".repeat(64));
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Load PR details" })).toBeNull();
});
it("keeps unknown repositories editable and never dispatches them", async () => {
  const test = fixture();
  await enter(test.user, "https://github.com/example-org/unknown/pull/42");
  expect((await screen.findByRole("alert")).textContent).toContain(
    "not configured",
  );
  expect(submitReview).not.toHaveBeenCalled();
  expect(test.readPull).not.toHaveBeenCalled();
  await test.user.clear(screen.getByRole("textbox", { name: "GitHub PR URL" }));
  await enter(test.user);
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain("Submitted"),
  );
});
it("does not claim a repository is absent when configuration reads are incomplete", async () => {
  vi.mocked(loadConfigurations).mockResolvedValue({
    rows: [],
    unreadable: 1,
    truncated: false,
  });
  const test = fixture();
  await enter(test.user);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Could not confirm",
  );
  expect(submitReview).not.toHaveBeenCalled();
});
it("shows existing threads and only claims notifications after successful delivery", async () => {
  vi.mocked(submitReview).mockImplementation(
    async (
      _s,
      _c,
      _config,
      _pr,
      _r,
      _signal,
      progress,
      _resume,
      _facts,
      existing,
    ) => {
      existing?.();
      progress(record);
      return record;
    },
  );
  const test = fixture();
  await enter(test.user);
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain(
      "Already exists — reviewers notified",
    ),
  );
  expect(test.readPull).not.toHaveBeenCalled();
  vi.mocked(submitReview).mockImplementationOnce(
    async (
      _s,
      _c,
      _config,
      _pr,
      _r,
      _signal,
      progress,
      _resume,
      _facts,
      existing,
    ) => {
      existing?.();
      progress(record);
      throw new Error("Notification rejected");
    },
  );
  await test.user.click(screen.getByRole("button", { name: "Submit PR" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Notification rejected",
  );
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("button", { name: "Open UI thread" })).toBeTruthy();
});
it("guards repeated clicks and aborts pending work when its page unmounts", async () => {
  let finish: () => void = () => {};
  let signal: AbortSignal | undefined;
  vi.mocked(submitReview).mockImplementationOnce(
    async (_s, _c, _config, _pr, _r, pending) => {
      signal = pending;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return record;
    },
  );
  const test = fixture();
  await enter(test.user);
  await waitFor(() => expect(submitReview).toHaveBeenCalledTimes(1));
  await test.user.click(screen.getByRole("button", { name: "Submit PR" }));
  expect(submitReview).toHaveBeenCalledTimes(1);
  expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
  test.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => finish());
});

it("shows all PRs in a table without submission controls, and deletion requires confirmation", async () => {
  vi.mocked(loadSubmissions).mockResolvedValue({ rows: [record], warning: "" });
  const test = fixture("all");
  const table = await screen.findByRole("table");
  expect(
    within(table).getByRole("columnheader", { name: "Lane threads" }),
  ).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  await test.user.click(
    screen.getByRole("button", { name: "Delete example-org/project#42" }),
  );
  expect(deleteSubmission).not.toHaveBeenCalled();
  await test.user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByRole("table")).toBeTruthy();
  await test.user.click(
    screen.getByRole("button", { name: "Delete example-org/project#42" }),
  );
  await test.user.click(
    screen.getByRole("button", { name: "Delete submission" }),
  );
  await waitFor(() => expect(screen.queryByRole("table")).toBeNull());
  expect(deleteSubmission).toHaveBeenCalledWith(
    test.session,
    "channel",
    expect.objectContaining(record),
    expect.any(AbortSignal),
  );
  expect(submitReview).not.toHaveBeenCalled();
});

it("keeps a row and explains recovery after an uncertain delete", async () => {
  vi.mocked(loadSubmissions).mockResolvedValue({ rows: [record], warning: "" });
  vi.mocked(deleteSubmission).mockRejectedValueOnce(
    new Error("Write timed out"),
  );
  const test = fixture("all");
  await test.user.click(
    await screen.findByRole("button", {
      name: "Delete example-org/project#42",
    }),
  );
  await test.user.click(
    screen.getByRole("button", { name: "Delete submission" }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain("reload");
  expect(screen.getByRole("table", { hidden: true })).toBeTruthy();
  expect(screen.getByRole("alertdialog")).toBeTruthy();
});

it("does not allow deleting someone else's submission", async () => {
  vi.mocked(loadSubmissions).mockResolvedValue({ rows: [record], warning: "" });
  fixture("all", "other");
  expect(
    (
      (await screen.findByRole("button", {
        name: "Delete example-org/project#42",
      })) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it("reload replaces the list so a submission deleted elsewhere disappears", async () => {
  vi.mocked(loadSubmissions)
    .mockResolvedValueOnce({ rows: [record], warning: "" })
    .mockResolvedValue({ rows: [], warning: "" });
  const test = fixture("all");
  await screen.findByRole("table");
  await test.user.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(screen.queryByRole("table")).toBeNull());
});

it("guards duplicate deletion and aborts it when leaving the page", async () => {
  vi.mocked(loadSubmissions).mockResolvedValue({ rows: [record], warning: "" });
  let finish = () => {};
  let pending: AbortSignal | undefined;
  vi.mocked(deleteSubmission).mockImplementationOnce(
    async (_s, _c, _row, signal) => {
      pending = signal;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  );
  const test = fixture("all");
  await test.user.click(
    await screen.findByRole("button", {
      name: "Delete example-org/project#42",
    }),
  );
  await test.user.click(
    screen.getByRole("button", { name: "Delete submission" }),
  );
  await waitFor(() => expect(deleteSubmission).toHaveBeenCalledTimes(1));
  await test.user.click(
    screen.getByRole("button", { name: "Delete submission" }),
  );
  expect(deleteSubmission).toHaveBeenCalledTimes(1);
  expect(
    (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  test.unmount();
  expect(pending?.aborted).toBe(true);
  await act(async () => finish());
});

it("reminds from a row, guards duplicate clicks and reports success or failure", async () => {
  vi.mocked(loadSubmissions).mockResolvedValue({ rows: [record], warning: "" });
  let finish = () => {};
  vi.mocked(remindSubmission).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return record;
  });
  const test = fixture("all");
  const button = await screen.findByRole("button", {
    name: "Remind UI reviewers for example-org/project#42",
  });
  await test.user.click(button);
  await test.user.type(
    screen.getByRole("textbox", { name: "Message (optional)" }),
    "Please have another look.",
  );
  await test.user.click(screen.getByRole("button", { name: "Send reminder" }));
  expect(screen.getByRole("status", { hidden: true }).textContent).toContain(
    "Reminding reviewers",
  );
  expect((button as HTMLButtonElement).disabled).toBe(true);
  await test.user.click(screen.getByRole("button", { name: "Send reminder" }));
  expect(remindSubmission).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  expect(screen.getByRole("status").textContent).toContain(
    "Reviewers reminded",
  );
  expect(remindSubmission).toHaveBeenCalledWith(
    test.session,
    "channel",
    expect.objectContaining(record),
    expect.any(AbortSignal),
    expect.any(Function),
    expect.stringContaining("pr_review_status_update"),
    "ui",
    "Please have another look.",
  );
  expect(submitReview).not.toHaveBeenCalled();
  vi.mocked(remindSubmission).mockRejectedValueOnce(
    new Error("Delivery failed"),
  );
  await test.user.click(button);
  await test.user.click(screen.getByRole("button", { name: "Send reminder" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Delivery failed",
  );
  expect(screen.queryByRole("status")).toBeNull();
});

it("aborts pending reminders when leaving the page", async () => {
  vi.mocked(loadSubmissions).mockResolvedValue({ rows: [record], warning: "" });
  let finish = () => {};
  let pending: AbortSignal | undefined;
  vi.mocked(remindSubmission).mockImplementationOnce(
    async (_s, _c, _r, signal) => {
      pending = signal;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return record;
    },
  );
  const test = fixture("all");
  await test.user.click(
    await screen.findByRole("button", {
      name: "Remind UI reviewers for example-org/project#42",
    }),
  );
  await test.user.click(screen.getByRole("button", { name: "Send reminder" }));
  test.unmount();
  expect(pending?.aborted).toBe(true);
  await act(async () => finish());
});

it.each(["Closed", "Merged", "Draft", "Open"] as const)(
  "shows %s and enables Remind only for open PRs",
  async (status) => {
    vi.mocked(loadSubmissions).mockResolvedValue({
      rows: [record],
      warning: "",
    });
    fixture("all", record.value.submitter, async () => status);
    await screen.findByRole("cell", { name: status });
    const button = screen.getByRole("button", {
      name: "Remind UI reviewers for example-org/project#42",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(status === "Closed" || status === "Merged");
  },
);

it("keeps Remind disabled while loading or unavailable and refreshes status on Reload", async () => {
  vi.mocked(loadSubmissions).mockImplementation(async () => ({
    rows: [record],
    warning: "",
  }));
  let reject = (_error: Error) => {};
  const readStatus = vi
    .fn<ReadPullStatus>()
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValue("Open");
  const test = fixture("all", record.value.submitter, readStatus);
  const button = (await screen.findByRole("button", {
    name: "Remind UI reviewers for example-org/project#42",
  })) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  await act(async () => reject(new Error("GitHub unavailable")));
  await screen.findByRole("cell", { name: "Unavailable" });
  expect(button.disabled).toBe(true);
  await test.user.click(screen.getByRole("button", { name: "Reload" }));
  await screen.findByRole("cell", { name: "Open" });
  expect(button.disabled).toBe(false);
});

it("limits status reads and aborts queued work when leaving the list", async () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({
    ...record,
    artifactId: `submission-${index}`,
    revision: `revision-${index}`,
    value: { ...record.value, pr: index + 1 },
  }));
  vi.mocked(loadSubmissions).mockResolvedValue({ rows, warning: "" });
  const signals: AbortSignal[] = [];
  const finish: (() => void)[] = [];
  const readStatus = vi.fn<ReadPullStatus>(async (_repo, _pr, signal) => {
    signals.push(signal);
    await new Promise<void>((resolve) => {
      finish.push(resolve);
    });
    return "Open";
  });
  const test = fixture("all", record.value.submitter, readStatus);
  await waitFor(() => expect(readStatus).toHaveBeenCalledTimes(4));
  test.unmount();
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  await act(async () => {
    for (const resolve of finish) resolve();
  });
  expect(readStatus).toHaveBeenCalledTimes(4);
});

it("recovers a report received while a reminder is still sending", async () => {
  const request = "11111111-1111-4111-8111-111111111111";
  const next: SavedSubmission = {
    ...record,
    revision: "f".repeat(64),
    value: {
      ...record.value,
      threads: [{ ...record.value.threads[0], request }],
    },
  };
  const report = {
    id: "1".repeat(64),
    kind: 9,
    created_at: 100,
    pubkey: "a".repeat(64),
    content: "Review status: Done.",
    tags: [
      ["h", "channel"],
      ["t", "buzz.review.status"],
      ["r", request],
      ["review", record.artifactId, "0"],
      ["e", "e".repeat(64), "", "reply"],
      ["status", "done"],
      ["review-sequence", "1"],
    ],
  } as import("../../features/relay/events").RelayEvent;
  vi.mocked(loadSubmissions)
    .mockResolvedValueOnce({ rows: [record], warning: "" })
    .mockResolvedValue({
      rows: [{ ...next, reviewReports: [report], reviewStates: ["done"] }],
      warning: "",
    });
  let finish: ((value: SavedSubmission) => void) | undefined;
  vi.mocked(remindSubmission).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const test = fixture("all");
  const row = (
    await screen.findByRole("link", { name: "example-org/project#42" })
  ).closest("tr");
  if (!row) throw new Error("Missing PR row");
  await waitFor(() => expect(test.readStatus).toHaveBeenCalledOnce());
  await test.user.click(
    within(row).getByRole("button", {
      name: "Remind UI reviewers for example-org/project#42",
    }),
  );
  await test.user.click(screen.getByRole("button", { name: "Send reminder" }));
  test.emit([report]);
  await act(async () => finish?.(next));
  await waitFor(() =>
    expect(
      screen.getAllByText("Completed · outcome unspecified", { exact: true })
        .length,
    ).toBeGreaterThan(0),
  );
  expect(loadSubmissions).toHaveBeenCalledTimes(2);
  const reads = vi.mocked(test.readStatus).mock.calls.length;
  test.emit([report]);
  expect(vi.mocked(test.readStatus).mock.calls.length).toBe(reads);
});

it("updates review reports in the live submission result, including snapshot buffering", async () => {
  const request = "11111111-1111-4111-8111-111111111111";
  const current = {
    ...record,
    value: {
      ...record.value,
      threads: [{ ...record.value.threads[0], request }],
    },
  };
  vi.mocked(submitReview).mockImplementation(
    async (_s, _c, _config, _pr, _r, _signal, progress) => {
      progress(current);
      return current;
    },
  );
  let finish: (value: { rows: SavedSubmission[]; warning: string }) => void =
    () => {};
  vi.mocked(loadSubmissions).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const test = fixture();
  await enter(test.user);
  await waitFor(() => expect(loadSubmissions).toHaveBeenCalledOnce());
  const report = {
    id: "1".repeat(64),
    kind: 9,
    created_at: 100,
    pubkey: "a".repeat(64),
    content: "Review status: Done.",
    tags: [
      ["h", "channel"],
      ["t", "buzz.review.status"],
      ["r", request],
      ["review", record.artifactId, "0"],
      ["e", "e".repeat(64), "", "reply"],
      ["status", "done"],
      ["review-sequence", "1"],
    ],
  } as import("../../features/relay/events").RelayEvent;
  test.emit([report]);
  await act(async () => finish({ rows: [current], warning: "" }));
  const result = screen.getByRole("region", { name: "Submission result" });
  expect(
    within(result).getAllByText("Completed · outcome unspecified", {
      exact: true,
    }),
  ).toHaveLength(2);
  test.emit([
    {
      ...report,
      id: "2".repeat(64),
      tags: report.tags.map((tag) =>
        tag[0] === "status"
          ? ["status", "wait_author"]
          : tag[0] === "review-sequence"
            ? ["review-sequence", "2"]
            : tag,
      ),
    },
  ]);
  expect(
    within(result).getAllByText("Waiting on author", { exact: true }),
  ).toHaveLength(2);
});

it("separates lane columns, omits triage reminders, and links status and latest messages", async () => {
  const row: SavedSubmission = {
    ...record,
    value: {
      ...record.value,
      version: 4,
      triage: {
        state: "admitted",
        agent: "a".repeat(64),
        instructions: "Check admission",
        head: "1".repeat(40),
        base: "2".repeat(40),
        reviewers: ["a".repeat(64)],
        thread: { id: "f".repeat(64), delivered: true },
        decision: "9".repeat(64),
        message: "Admitted",
      },
    },
  };
  vi.mocked(loadSubmissions).mockResolvedValue({ rows: [row], warning: "" });
  const test = fixture("all");
  expect(screen.queryByRole("columnheader", { name: "Delivery" })).toBeNull();
  for (const name of ["Lane threads", "Lane status", "Lane last message"])
    expect(await screen.findByRole("columnheader", { name })).toBeTruthy();
  const triage = screen.getByText("Admission Triage").closest("tr");
  if (!triage) throw new Error("Missing triage row");
  expect(within(triage).queryByRole("button", { name: /Remind/ })).toBeNull();
  expect(
    screen.getAllByRole("button", { name: /Remind .* reviewers/ }),
  ).toHaveLength(1);
  await test.user.click(
    screen.getByRole("link", {
      name: "Full message: example-org/project#42 Admission Triage last message",
    }),
  );
  expect(test.onOpenMessage).toHaveBeenLastCalledWith(
    "channel",
    "e".repeat(64),
    expect.any(HTMLElement),
  );
  await test.user.click(
    await screen.findByRole("link", {
      name: "Full message: example-org/project#42 UI last message",
    }),
  );
  expect(test.onOpenMessage).toHaveBeenLastCalledWith(
    "channel",
    "e".repeat(64),
    expect.any(HTMLElement),
  );
});

it("rebinds a failed reminder to its saved revision and preserves the original message on retry", async () => {
  const pending: SavedSubmission = {
    ...record,
    revision: "f".repeat(64),
    value: {
      ...record.value,
      notifying: true,
      notifyingLane: "ui",
      reminderMessage: "Please check the fix.",
    },
  };
  vi.mocked(loadSubmissions)
    .mockResolvedValueOnce({ rows: [record], warning: "" })
    .mockResolvedValue({ rows: [pending], warning: "" });
  vi.mocked(remindSubmission)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(record);
  const test = fixture("all");
  await test.user.click(
    await screen.findByRole("button", {
      name: "Remind UI reviewers for example-org/project#42",
    }),
  );
  await test.user.type(
    screen.getByRole("textbox", { name: "Message (optional)" }),
    "Please check the fix.",
  );
  await test.user.click(screen.getByRole("button", { name: "Send reminder" }));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("textbox", {
          name: "Message (optional)",
        }) as HTMLTextAreaElement
      ).disabled,
    ).toBe(true),
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Send reminder",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  await test.user.click(screen.getByRole("button", { name: "Send reminder" }));
  expect(vi.mocked(remindSubmission).mock.calls[1]?.[2].revision).toBe(
    pending.revision,
  );
  expect(vi.mocked(remindSubmission).mock.calls[1]?.[7]).toBe(
    "Please check the fix.",
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

it("waits for fresh channel access before loading submissions and lane previews", async () => {
  vi.mocked(loadSubmissions).mockResolvedValue({ rows: [record], warning: "" });
  const test = fixture("all", record.value.submitter, undefined, false);
  expect(loadSubmissions).not.toHaveBeenCalled();
  expect(test.session.thread).not.toHaveBeenCalled();
  test.setReadable(true);
  await screen.findByRole("link", {
    name: "Full message: example-org/project#42 UI last message",
  });
  expect(loadSubmissions).toHaveBeenCalledTimes(1);
  expect(test.session.thread).toHaveBeenCalledTimes(1);
  test.setReadable(false);
  await waitFor(() =>
    expect(screen.queryByText("The complete latest message")).toBeNull(),
  );
  test.setReadable(true);
  await screen.findByRole("link", {
    name: "Full message: example-org/project#42 UI last message",
  });
  expect(loadSubmissions).toHaveBeenCalledTimes(2);
});

it("clears the shared badge on opening and keeps lane highlights until the next visit", async () => {
  const request = "11111111-1111-4111-8111-111111111111";
  const uiLane = configuration.config.lanes[0];
  if (!uiLane) throw new Error("Missing UI lane fixture");
  const base: SavedSubmission = {
    ...record,
    value: {
      ...record.value,
      config: {
        ...record.value.config,
        lanes: [
          uiLane,
          {
            ...uiLane,
            id: "backend",
            name: "Backend",
          },
        ],
      },
      threads: [
        { id: "e".repeat(64), request, delivered: true },
        { id: "f".repeat(64), request, delivered: true },
      ],
    },
  };
  const report = (index: number, time: number) =>
    ({
      id: String(index + 1).repeat(64),
      kind: 9,
      created_at: time,
      pubkey: "a".repeat(64),
      content: "Review status: Reviewing.",
      tags: [
        ["h", "channel"],
        ["t", "buzz.review.status"],
        ["r", request],
        ["review", record.artifactId, String(index)],
        ["e", (index === 0 ? "e" : "f").repeat(64), "", "reply"],
        ["status", "reviewing"],
        ["review-sequence", "1"],
      ],
    }) as import("../../features/relay/events").RelayEvent;
  const first = applyReviewReports(base, "channel", [report(0, 200)]);
  vi.mocked(loadSubmissions).mockResolvedValue({ rows: [first], warning: "" });
  const view = fixture("all", undefined, undefined, true, null);
  await view.user.click(
    await screen.findByRole("button", { name: "example-org/project#42" }),
  );
  const ui = (await screen.findByText("UI", { exact: true })).closest("tr");
  const backend = screen.getByText("Backend", { exact: true }).closest("tr");
  if (!ui || !backend) throw new Error("Missing lane rows");
  expect(within(ui).getAllByText("Updated").length).toBeGreaterThan(0);
  expect(within(backend).queryByText("Updated")).toBeNull();
  expect(screen.getByTestId("unseen-updates").textContent).toBe("0");
  expect(screen.queryByRole("button", { name: /Mark .* seen/ })).toBeNull();
  expect(
    within(ui)
      .getByText(/^Last updated:/)
      .querySelector("time")?.dateTime,
  ).toBe(new Date(200_000).toISOString());
  view.emit([report(1, 300)]);
  expect(within(backend).getByText("Updated")).toBeTruthy();
  expect(
    within(backend)
      .getByText(/^Last updated:/)
      .querySelector("time")?.dateTime,
  ).toBe(new Date(300_000).toISOString());
  expect(screen.getByTestId("unseen-updates").textContent).toBe("0");
  view.unmount();
  const final = applyReviewReports(first, "channel", [report(1, 300)]);
  vi.mocked(loadSubmissions).mockResolvedValue({ rows: [final], warning: "" });
  fixture("all");
  await screen.findByText("Backend", { exact: true });
  expect(screen.queryByText("Updated")).toBeNull();
  expect(screen.getByTestId("unseen-updates").textContent).toBe("0");
});

it("shows one compact row per PR and opens only that PR's lane details", async () => {
  const second: SavedSubmission = {
    ...record,
    artifactId: "second",
    revision: "f".repeat(64),
    value: { ...record.value, pr: 43 },
  };
  vi.mocked(loadSubmissions).mockResolvedValue({
    rows: [record, second],
    warning: "",
  });
  const test = fixture("all", undefined, undefined, true, null);
  const first = await screen.findByRole("button", {
    name: "example-org/project#42",
  });
  const table = screen.getByRole("table");
  expect(within(table).getAllByRole("row")).toHaveLength(3);
  expect(within(table).getAllByText("1 needs review")).toHaveLength(2);
  expect(
    within(table).queryByRole("columnheader", { name: "Lane threads" }),
  ).toBeNull();
  expect(test.session.thread).not.toHaveBeenCalled();
  first.focus();
  await test.user.keyboard("{Enter}");
  expect(test.onOpenSubmission).toHaveBeenCalledWith(
    "channel",
    record.artifactId,
  );
  expect(
    await screen.findByRole("button", { name: "Open UI thread" }),
  ).toBeTruthy();
  expect(screen.queryByText("example-org/project#43")).toBeNull();
  expect(test.session.thread).toHaveBeenCalledTimes(1);
  test.select(null);
  const restored = screen.getByRole("button", {
    name: "example-org/project#42",
  });
  expect(document.activeElement).toBe(restored);
  const row = screen
    .getByRole("button", { name: "example-org/project#43" })
    .closest("tr");
  if (!row) throw new Error("Missing second row");
  await test.user.click(within(row).getByText("1 needs review"));
  expect(test.onOpenSubmission).toHaveBeenLastCalledWith("channel", "second");
  expect(
    screen.getByRole("rowgroup", { name: "example-org/project#43" }),
  ).toBeTruthy();
});

it("shows recovery for a missing detail without opening unrelated lane threads", async () => {
  vi.mocked(loadSubmissions).mockResolvedValue({ rows: [record], warning: "" });
  const test = fixture("all", undefined, undefined, true, "missing");
  expect(
    (await screen.findByText(/This submission is unavailable/)).textContent,
  ).toContain("Reload");
  expect(test.session.thread).not.toHaveBeenCalled();
  expect(screen.queryByRole("table")).toBeNull();
  test.select(null);
  expect(
    await screen.findByRole("button", { name: "example-org/project#42" }),
  ).toBeTruthy();
});

it("keeps updates to other PRs unread while inspecting one detail", async () => {
  const request = "11111111-1111-4111-8111-111111111111";
  const second: SavedSubmission = {
    ...record,
    artifactId: "second",
    revision: "f".repeat(64),
    value: {
      ...record.value,
      pr: 43,
      threads: [{ id: "e".repeat(64), request, delivered: true }],
    },
  };
  vi.mocked(loadSubmissions).mockResolvedValue({
    rows: [record, second],
    warning: "",
  });
  const test = fixture("all");
  await screen.findByRole("button", { name: "Open UI thread" });
  test.emit([
    {
      id: "1".repeat(64),
      kind: 9,
      created_at: 200,
      pubkey: "a".repeat(64),
      content: "Reviewing",
      tags: [
        ["h", "channel"],
        ["t", "buzz.review.status"],
        ["r", request],
        ["review", "second", "0"],
        ["e", "e".repeat(64), "", "reply"],
        ["status", "reviewing"],
        ["review-sequence", "1"],
      ],
    } as import("../../features/relay/events").RelayEvent,
  ]);
  expect(screen.getByTestId("unseen-updates").textContent).toBe("1");
  expect(screen.queryByText("Updated")).toBeNull();
  test.select(null);
  expect(screen.getByTestId("unseen-updates").textContent).toBe("0");
  const row = screen
    .getByRole("button", { name: "example-org/project#43" })
    .closest("tr");
  if (!row) throw new Error("Missing updated PR");
  expect(within(row).getByText("Updated")).toBeTruthy();
});

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelKit } from "../../features/channel-templates/capability";
import {
  emptyLineup,
  type KitEntry,
} from "../../features/channel-templates/model";
import { ChannelTemplatesDialog } from "./ChannelTemplatesDialog";

afterEach(cleanup);
const entry: KitEntry = {
  eventId: "head",
  createdAt: 1,
  record: {
    version: 1,
    community: "https://relay.example.test",
    deleted: false,
    value: { type: "team", id: "team", name: "Saved team", agents: [] },
  },
};
function fixture(entries: KitEntry[] = [entry]) {
  const state = { status: "ready" as const, entries };
  const save = vi.fn<ChannelKit["save"]>();
  const kit: ChannelKit = {
    available: true,
    snapshot: () => state,
    subscribe: () => () => {},
    ensure: vi.fn(),
    refresh: vi.fn(),
    save,
  };
  const close = vi.fn();
  render(
    <ChannelTemplatesDialog
      open
      onOpenChange={close}
      kit={kit}
      agents={[]}
      active={() => true}
    />,
  );
  return { save, close };
}
it("delete cancellation closes only the nested layer without deleting or closing the library", async () => {
  const user = userEvent.setup();
  const { save, close } = fixture();
  await user.click(screen.getByRole("tab", { name: "Teams" }));
  const trigger = screen.getByRole("button", { name: "Delete" });
  for (const dismissal of ["backdrop", "escape", "close", "cancel"]) {
    await user.click(trigger);
    const confirmation = screen.getByRole("dialog", {
      name: "Delete “Saved team”?",
    });
    await waitFor(() =>
      expect(
        within(confirmation).getByRole("button", { name: "Cancel" }),
      ).toHaveFocus(),
    );
    await user.click(within(confirmation).getByRole("heading"));
    expect(confirmation).toBeInTheDocument();
    if (dismissal === "backdrop")
      await user.click(
        confirmation.parentElement?.querySelector(
          ".buzz-dialog-backdrop",
        ) as Element,
      );
    else if (dismissal === "escape") await user.keyboard("{Escape}");
    else
      await user.click(
        within(confirmation).getByRole("button", {
          name: dismissal === "close" ? "Close" : "Cancel",
        }),
      );
    await waitFor(() => expect(confirmation).not.toBeInTheDocument());
    // jsdom lacks focus({ preventScroll }) detection; browser coverage checks pointer return.
    if (dismissal !== "backdrop")
      await waitFor(() => expect(trigger).toHaveFocus());
    expect(
      screen.getByRole("dialog", { name: "Templates & teams" }),
    ).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  }
  await user.click(document.querySelector(".buzz-dialog-backdrop") as Element);
  expect(close).toHaveBeenCalledExactlyOnceWith(false);
});
it("confirmed deletion preserves the expected revision and locks dismissal until failure", async () => {
  const user = userEvent.setup();
  const { save, close } = fixture();
  let reject!: (error: Error) => void;
  const pending = new Promise<never>((_, no) => {
    reject = no;
  });
  save.mockReturnValueOnce(pending);
  await user.click(screen.getByRole("tab", { name: "Teams" }));
  await user.click(screen.getByRole("button", { name: "Delete" }));
  const confirmation = screen.getByRole("dialog", {
    name: "Delete “Saved team”?",
  });
  await user.click(
    within(confirmation).getByRole("button", { name: "Delete" }),
  );
  try {
    expect(save).toHaveBeenCalledExactlyOnceWith(
      entry.record.value,
      "head",
      true,
    );
    await waitFor(() => expect(confirmation).not.toBeInTheDocument());
    expect(
      screen.getByRole("button", { name: "Close templates" }),
    ).toBeDisabled();
    await user.click(
      document.querySelector(".buzz-dialog-backdrop") as Element,
    );
    await user.keyboard("{Escape}");
    expect(close).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      reject(new Error("Delete rejected"));
      await pending.catch(() => {});
    });
  }
  expect(await screen.findByRole("alert")).toHaveTextContent("Delete rejected");
  expect(screen.getByRole("button", { name: "Close templates" })).toBeEnabled();
  await user.click(document.querySelector(".buzz-dialog-backdrop") as Element);
  expect(close).toHaveBeenCalledExactlyOnceWith(false);
  expect(save).toHaveBeenCalledOnce();
});

it("shows a contextual library action and discloses optional template fields without losing edits", async () => {
  const user = userEvent.setup();
  const { save } = fixture();
  expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
    /Private to you in this community/,
  );
  expect(screen.getByText("No templates yet")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "New team" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "New template" }));
  expect(
    screen.getByRole("dialog", { name: "New template" }),
  ).toHaveAccessibleDescription(/existing channels stay unchanged/);
  const name = screen.getByRole("textbox", { name: "Name" });
  expect(name).toHaveFocus();
  const submit = screen.getByRole("button", { name: "Save template" });
  expect(submit).toBeDisabled();
  expect(
    screen.queryByRole("textbox", { name: "Starting Canvas (Markdown)" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("group", { name: "Saved teams" }),
  ).not.toBeInTheDocument();
  await user.type(name, "Project kickoff");
  await user.click(screen.getByRole("button", { name: "Teams & agents" }));
  await user.click(screen.getByRole("checkbox", { name: "Saved team (0)" }));
  const members = screen.getByRole("button", { name: "Teams & agents (1)" });
  await user.click(members);
  expect(members).toHaveAttribute("aria-expanded", "false");
  await user.click(members);
  expect(
    screen.getByRole("checkbox", { name: "Saved team (0)" }),
  ).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Starting Canvas" }));
  await user.type(
    screen.getByRole("textbox", { name: "Starting Canvas (Markdown)" }),
    "# Plan",
  );
  await user.click(
    screen.getByRole("button", { name: "Starting Canvas · Added" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Starting Canvas · Added" }),
  );
  expect(
    screen.getByRole("textbox", { name: "Starting Canvas (Markdown)" }),
  ).toHaveValue("# Plan");
  let reject!: (error: Error) => void;
  const pending = new Promise<string>((_, no) => {
    reject = no;
  });
  save.mockReturnValueOnce(pending);
  await user.click(submit);
  try {
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Project kickoff",
        teamIds: ["team"],
        canvas: "# Plan",
      }),
      undefined,
      false,
    );
    expect(submit).toHaveAttribute("aria-busy", "true");
    expect(
      screen.getByRole("button", { name: "Back to library" }),
    ).toBeDisabled();
  } finally {
    await act(async () => {
      reject(new Error("Save rejected"));
      await pending.catch(() => {});
    });
  }
  expect(await screen.findByRole("alert")).toHaveTextContent("Save rejected");
  expect(name).toHaveValue("Project kickoff");
  save.mockResolvedValueOnce("saved");
  await user.click(submit);
  expect(await screen.findByRole("tab", { name: "Templates" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("button", { name: "New template" })).toHaveFocus();
  await user.click(screen.getByRole("tab", { name: "Teams" }));
  await user.click(screen.getByRole("button", { name: "New team" }));
  expect(
    screen.getByRole("dialog", { name: "New team" }),
  ).toHaveAccessibleDescription(/Choose agents/);
  expect(
    screen.queryByRole("textbox", { name: "Description" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("textbox", { name: "Find individual agents" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText(/No agents from the Agents page/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Back to library" }));
  expect(screen.getByRole("tab", { name: "Teams" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("button", { name: "New team" })).toHaveFocus();
});

it("opens saved optional sections and keeps missing-member errors visible when collapsed", async () => {
  const user = userEvent.setup();
  const saved = {
    ...entry,
    record: {
      ...entry.record,
      value: {
        ...emptyLineup(),
        type: "template" as const,
        id: "saved",
        name: "Saved template",
        description: "Kickoff",
        teamIds: ["missing"],
        canvas: "# Goal",
      },
    },
  };
  const { save } = fixture([saved]);
  await user.click(screen.getByRole("button", { name: "Saved template" }));
  expect(screen.getByRole("dialog", { name: "Edit template" })).toBeVisible();
  expect(
    screen.getByRole("textbox", { name: "Starting Canvas (Markdown)" }),
  ).toHaveValue("# Goal");
  expect(
    screen.getByRole("checkbox", { name: "Unavailable team (0)" }),
  ).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Teams & agents (1)" }));
  expect(screen.getByRole("alert")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Back to library" }));
  expect(save).not.toHaveBeenCalled();
});

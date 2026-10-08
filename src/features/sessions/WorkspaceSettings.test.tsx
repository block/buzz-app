// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import { WorkspaceSettings } from "./WorkspaceSettings";
import { readWorkspace, sectionTemplateId, workspaceCanvas } from "./workspace";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("edits a session's workspace and Canvas with its exact loaded revision", async () => {
  const save = vi.fn(
    async (_channel: string, _content: string, _revision?: string) => ({}),
  );
  const close = vi.fn();
  const session = {
    canvas: {
      read: async () => ({
        id: "revision-one",
        content: workspaceCanvas({
          folders: ["/repo"],
          canvas: "Keep this context",
        }),
      }),
      save,
    },
  } as unknown as RelaySession;
  render(
    <WorkspaceSettings
      session={session}
      scope="test"
      target={{ kind: "session", id: "session", name: "Plan" }}
      close={close}
    />,
  );
  const folders = await screen.findByRole("textbox", {
    name: "Project folders",
  });
  expect(folders).toHaveValue("/repo");
  fireEvent.change(folders, { target: { value: "/other\n/repo" } });
  fireEvent.click(
    screen.getByRole("switch", { name: "Work in a new worktree" }),
  );
  expect(screen.queryByRole("textbox", { name: "Project folders" })).toBeNull();
  expect(
    screen.getByRole("textbox", { name: "Source repository 1" }),
  ).toHaveValue("/other");
  expect(
    screen.getByRole("textbox", { name: "Source repository 2" }),
  ).toHaveValue("/repo");
  fireEvent.change(screen.getByRole("textbox", { name: "Base branch" }), {
    target: { value: "develop" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(save).toHaveBeenCalledWith(
    "session",
    expect.stringContaining("origin/develop"),
    "revision-one",
  );
  expect(
    readWorkspace(save.mock.calls[0]?.[1] as unknown as string).canvas,
  ).toBe("Keep this context");
});

it("retains a conflicted draft and never silently reloads over it", async () => {
  const save = vi.fn(async () => {
    throw new Error("Canvas changed elsewhere");
  });
  const close = vi.fn();
  const session = {
    canvas: { read: async () => ({ id: "old", content: "Original" }), save },
  } as unknown as RelaySession;
  const view = () => (
    <WorkspaceSettings
      session={session}
      scope="test"
      target={{ kind: "session", id: "session", name: "Plan" }}
      close={close}
    />
  );
  const mounted = render(view());
  fireEvent.change(await screen.findByRole("textbox", { name: "Canvas" }), {
    target: { value: "My draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Canvas changed elsewhere",
  );
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Canvas" })).toHaveValue(
    "My draft",
  );
  mounted.unmount();
  render(view());
  expect(await screen.findByRole("textbox", { name: "Canvas" })).toHaveValue(
    "My draft",
  );
});

it("saves section defaults as an existing relay template without writing section placement", async () => {
  const save = vi.fn(async () => {});
  const close = vi.fn();
  const session = {
    channelKit: {
      refresh: async () => {},
      snapshot: () => ({ status: "ready", entries: [] }),
      save,
    },
  } as unknown as RelaySession;
  render(
    <WorkspaceSettings
      session={session}
      scope="test"
      target={{ kind: "section", id: "work", name: "Work" }}
      close={close}
    />,
  );
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Project folders" }),
    { target: { value: "~/Development/project" } },
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Canvas" }), {
    target: { value: "Work carefully" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "template",
      id: await sectionTemplateId("work"),
      canvas: expect.stringContaining("Work carefully"),
    }),
    undefined,
  );
});

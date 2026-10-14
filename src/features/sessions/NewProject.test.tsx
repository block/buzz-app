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
import {
  parseKitRecord,
  type KitEntry,
  type Template,
} from "../channel-templates/model";
import { NewProject } from "./NewProject";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// This is the dialog's orchestration boundary: a project write and a separate
// defaults write can each fail. Protocol validation belongs to the real kit tests.
it("keeps a partially saved project frozen and reconciles its saved defaults on retry", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entries: KitEntry[] = [];
  const create = vi.fn(async () => {});
  const save = vi.fn(async (template: Template) => {
    await gate;
    entries = [
      {
        record: parseKitRecord(
          { version: 1, community: "", deleted: false, value: template },
          "",
        ),
        eventId: "saved",
        createdAt: 1,
      },
    ];
    throw new Error("Save not confirmed");
  });
  const close = vi.fn();
  render(
    <NewProject
      create={create}
      close={close}
      onCreated={vi.fn()}
      session={
        {
          channelKit: {
            refresh: async () => {},
            snapshot: () => ({ status: "ready", entries }),
            save,
          },
        } as unknown as RelaySession
      }
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Work" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), {
    target: { value: "Keep changes small" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  try {
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute(
      "readonly",
    );
  } finally {
    release();
  }
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Save not confirmed",
  );
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(
    "Keep changes small",
  );
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledOnce();
  expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
});

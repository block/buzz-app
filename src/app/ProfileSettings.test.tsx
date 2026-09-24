// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  Communities,
  PersonalProfile,
} from "../features/communities/service";
import { ProfileSettings } from "./ProfileSettings";

afterEach(cleanup);

function setup() {
  let state = { status: "ready", profile: { name: "Arjun", picture: "" } };
  const listeners = new Set<() => void>();
  const saveProfile = vi.fn((profile: PersonalProfile) => {
    state = { ...state, profile };
    for (const listener of listeners) listener();
  });
  const communities = {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    saveProfile,
  } as unknown as Communities;
  render(<ProfileSettings communities={communities} />);
  return {
    saveProfile,
    name: screen.getByRole("textbox", { name: "Display name" }),
  };
}

it("shows Cancel then Save only for edits, including picture edits, and restores on cancel", () => {
  const { name, saveProfile } = setup();
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  fireEvent.change(name, { target: { value: "Updated" } });
  expect(
    screen.getAllByRole("button").map((button) => button.textContent),
  ).toEqual(["Cancel", "Save"]);
  fireEvent.change(name, { target: { value: "Arjun" } });
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  const picture = screen.getByRole("textbox", {
    name: "Picture URL (optional)",
  });
  fireEvent.change(picture, {
    target: { value: "https://example.com/avatar.png" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(picture).toHaveValue("");
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  expect(saveProfile).not.toHaveBeenCalled();
});

it("retains edits on failure and hides actions after a successful retry", () => {
  const { name, saveProfile } = setup();
  fireEvent.change(name, { target: { value: "Updated" } });
  saveProfile.mockImplementationOnce(() => {
    throw new Error("Could not save");
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Could not save");
  expect(name).toHaveValue("Updated");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Profile updated.");
});

it("keeps cancel available for invalid edits and refuses unchanged form submission", () => {
  const { name, saveProfile } = setup();
  const form = name.closest("form");
  if (!form) throw new Error("Profile form missing");
  fireEvent.submit(form);
  expect(saveProfile).not.toHaveBeenCalled();
  fireEvent.change(name, { target: { value: "" } });
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
});

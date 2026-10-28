// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Context } from "@deepseek-ai/cordis";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createCommunities } from "./service";
import { LegacyCommunityImport } from "./LegacyCommunityImport";
import { flush } from "../relay/testing";

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(),
}));
const viewer = "a".repeat(64);
const marker = `buzz-legacy-communities.v1:${viewer}`;
const record = `buzz-client.v1:${viewer}`;
const roots: Context[] = [];
afterEach(async () => {
  cleanup();
  for (const root of roots.splice(0)) await root.fiber.dispose();
  localStorage.clear();
  vi.mocked(invoke).mockReset();
});

function fixture() {
  vi.mocked(invoke).mockResolvedValue([
    { relayUrl: "wss://old.example", pubkey: viewer },
  ]);
  const root = new Context();
  roots.push(root);
  const communities = createCommunities(
    root,
    false,
    undefined,
    "",
    undefined,
    Promise.resolve(viewer),
  );
  const mount = () =>
    render(
      <StrictMode>
        <LegacyCommunityImport communities={communities} />
      </StrictMode>,
    );
  return { communities, mount, user: userEvent.setup() };
}

it("imports only after the owner approves the listed communities", async () => {
  const { communities, mount, user } = fixture();
  const view = mount();
  await screen.findByRole("alertdialog", {
    name: "Import communities from old Buzz?",
  });
  expect(
    screen.getByRole("list", { name: "Communities to import" }),
  ).toHaveTextContent("https://old.example");
  expect(
    screen.getByText(/may restore communities you previously removed/),
  ).toBeVisible();
  expect(communities.snapshot().memberships).toEqual([]);
  expect(localStorage.getItem(record)).toBeNull();
  expect(localStorage.getItem(marker)).toBeNull();
  await user.click(screen.getByRole("button", { name: "Import communities" }));
  await waitFor(() => expect(localStorage.getItem(marker)).toBe("1"));
  expect(communities.snapshot().memberships).toEqual([
    { id: "https://old.example", name: "old.example" },
  ]);
  expect(communities.snapshot().sync.outbox).toEqual([
    { url: "wss://old.example", removed: false },
  ]);
  const calls = vi.mocked(invoke).mock.calls.length;
  view.unmount();
  mount();
  await act(flush);
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(invoke).toHaveBeenCalledTimes(calls);
});

it("remembers a declined import across mounts", async () => {
  const { communities, mount, user } = fixture();
  const view = mount();
  await screen.findByRole("alertdialog");
  await user.click(screen.getByRole("button", { name: "Skip import" }));
  await waitFor(() => expect(localStorage.getItem(marker)).toBe("1"));
  expect(communities.snapshot().memberships).toEqual([]);
  expect(localStorage.getItem(record)).toBeNull();
  view.unmount();
  mount();
  await act(flush);
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});

it("does not persist a decline when a pending consent dialog unmounts", async () => {
  const { communities, mount } = fixture();
  const view = mount();
  await screen.findByRole("alertdialog");
  view.unmount();
  await act(flush);
  expect(communities.snapshot().memberships).toEqual([]);
  expect(localStorage.getItem(marker)).toBeNull();
  mount();
  expect(await screen.findByRole("alertdialog")).toBeVisible();
});

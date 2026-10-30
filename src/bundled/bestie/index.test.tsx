// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { deferred } from "../builderlab/test-helpers";
import { bestieFixture, cleanups } from "./testing";

const native = vi.hoisted(() => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);
composerDOMFixture();
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

beforeEach(() => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
});
afterEach(async () => {
  cleanup();
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
  localStorage.clear();
  native.invoke.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const renderPage = (h: Awaited<ReturnType<typeof bestieFixture>>) => {
  const Page = h.pages.snapshot()[0]?.component;
  if (!Page) throw new Error("Missing Bestie page");
  return render(<Page />);
};

it("waits for the account choice before showing the chooser", async () => {
  const choice = deferred<string | undefined>();
  const h = await bestieFixture(native.invoke, {
    mainAgent: {
      read: () => choice.promise,
      write: async () => {},
    },
  });
  renderPage(h);
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Reading your saved choice.",
  );
  expect(
    screen.queryByRole("button", { name: "Create agent" }),
  ).not.toBeInTheDocument();
  await act(async () => choice.resolve(undefined));
  expect(
    await screen.findByRole("button", { name: "Create agent" }),
  ).toBeVisible();
});

it("replaces hosted setup with the manual Bestie chooser", async () => {
  const h = await bestieFixture(native.invoke);
  renderPage(h);
  expect(
    await screen.findByRole("heading", { name: "Choose your Bestie" }),
  ).toBeVisible();
  expect(
    screen.getByText(
      "Choose an eligible agent, or create one to make your Bestie in Buzz.",
    ),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Set up Bestie" }),
  ).not.toBeInTheDocument();
});

it("opens the existing new-agent dialog from the chooser", async () => {
  const h = await bestieFixture(native.invoke);
  renderPage(h);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Create agent" }));
  expect(screen.getByRole("dialog", { name: "Create agent" })).toBeVisible();
});

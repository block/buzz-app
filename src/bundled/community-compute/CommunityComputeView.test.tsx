// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  CommunityComputeView,
  type ComputeControls,
} from "./CommunityComputeView";
import { SMALL_COMPANY_COMMUNITY_COMPUTE_FIXTURE } from "./communityComputeFixtures";

afterEach(cleanup);
function controls(overrides: Partial<ComputeControls> = {}): ComputeControls {
  return {
    status: { state: "off", mode: null, modelId: null },
    models: [{ id: "local-model", label: "Local model", recommended: true }],
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    ...overrides,
  };
}
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
it("registers an honest unavailable view with no invented live data or enabled actions", () => {
  render(<CommunityComputeView />);
  expect(
    screen.getByRole("switch", { name: "Share your machine" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(
    screen.getByText("Sharing compute isn’t available in this build yet."),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Create community agent" }),
  ).toBeDisabled();
  expect(
    screen.queryByRole("region", { name: "Community compute map" }),
  ).toBeNull();
  expect(screen.queryByText("0 GB")).toBeNull();
  expect(screen.queryByText("Interactive preview.")).toBeNull();
});
it("does not start on mount; starts only the chosen local model with a valid memory limit", async () => {
  const api = controls();
  const user = userEvent.setup();
  render(
    <StrictMode>
      <CommunityComputeView controls={api} />
    </StrictMode>,
  );
  expect(api.start).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Model to share")).toHaveValue("local-model");
  await user.click(screen.getByText("Advanced"));
  fireEvent.change(screen.getByLabelText("Maximum shared memory (GB)"), {
    target: { value: "32" },
  });
  await user.click(screen.getByRole("switch"));
  expect(api.start).toHaveBeenCalledExactlyOnceWith({
    modelId: "local-model",
    maxVramGb: 32,
  });
});
it("does not resurrect the recommendation when the model is cleared and blocks invalid memory", async () => {
  const api = controls();
  const user = userEvent.setup();
  render(<CommunityComputeView controls={api} />);
  await user.clear(screen.getByLabelText("Model to share"));
  expect(screen.getByRole("switch")).toHaveAttribute("aria-disabled", "true");
  await user.type(screen.getByLabelText("Model to share"), "another-model");
  await user.click(screen.getByText("Advanced"));
  fireEvent.change(screen.getByLabelText("Maximum shared memory (GB)"), {
    target: { value: "0" },
  });
  expect(screen.getByRole("switch")).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("alert")).toHaveTextContent("greater than zero");
  expect(api.start).not.toHaveBeenCalled();
});
it("keeps a consuming model out of the local share selection and never stops it", async () => {
  const api = controls({
    status: { state: "running", mode: "client", modelId: "huge-remote-model" },
  });
  render(<CommunityComputeView controls={api} />);
  expect(screen.getByRole("switch")).not.toBeChecked();
  expect(screen.getByLabelText("Model to share")).toHaveValue("local-model");
  await userEvent.click(screen.getByRole("switch"));
  expect(api.start).toHaveBeenCalledWith({ modelId: "local-model" });
  expect(api.stop).not.toHaveBeenCalled();
});
it("blocks a catalog model that is too large even with surrounding whitespace", async () => {
  const api = controls({
    models: [{ id: "too-large", label: "Too large", tooLarge: true }],
  });
  render(<CommunityComputeView controls={api} />);
  fireEvent.change(screen.getByLabelText("Model to share"), {
    target: { value: " too-large " },
  });
  expect(screen.getByRole("switch")).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("alert")).toHaveTextContent("needs more memory");
  await userEvent.click(screen.getByRole("switch"));
  expect(api.start).not.toHaveBeenCalled();
});
it("reports startup failure and permits a retry", async () => {
  const api = controls({
    start: vi
      .fn()
      .mockRejectedValueOnce(new Error("Download failed"))
      .mockResolvedValueOnce(undefined),
  });
  render(<CommunityComputeView controls={api} />);
  await userEvent.click(screen.getByRole("switch"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Download failed");
  await userEvent.click(screen.getByRole("switch"));
  expect(api.start).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
});
it("lets authoritative running status unlock Stop and ignores a retired startup rejection", async () => {
  const start = deferred(),
    stop = deferred();
  const api = controls({
    start: vi.fn(() => start.promise),
    stop: vi.fn(() => stop.promise),
  });
  const page = render(<CommunityComputeView controls={api} />);
  await userEvent.click(screen.getByRole("switch"));
  expect(screen.getByRole("switch")).toHaveAttribute("aria-disabled", "true");
  page.rerender(
    <CommunityComputeView
      controls={{
        ...api,
        status: { state: "running", mode: "serve", modelId: "local-model" },
      }}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("switch")).not.toHaveAttribute(
      "aria-disabled",
      "true",
    ),
  );
  await userEvent.click(screen.getByRole("switch"));
  expect(api.stop).toHaveBeenCalledTimes(1);
  // Runtime disappears before persistent sharing config has finished saving.
  page.rerender(<CommunityComputeView controls={api} />);
  expect(screen.getByRole("switch")).toHaveAttribute("aria-disabled", "true");
  await act(async () => {
    start.reject(new Error("Late startup failure"));
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("switch")).toHaveAttribute("aria-disabled", "true");
  await act(async () => {
    stop.resolve();
  });
  expect(screen.getByRole("switch")).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
});
it("leaving the page does not implicitly stop a sharing runtime", () => {
  const api = controls({
    status: { state: "running", mode: "serve", modelId: "local-model" },
  });
  const page = render(
    <StrictMode>
      <CommunityComputeView controls={api} />
    </StrictMode>,
  );
  page.unmount();
  expect(api.stop).not.toHaveBeenCalled();
});
it("shows bounded download progress and handles an unknown download size", () => {
  const api = controls({
    status: {
      state: "starting",
      mode: "serve",
      modelId: "local-model",
      download: { received: 120, total: 100 },
    },
  });
  const page = render(<CommunityComputeView controls={api} />);
  expect(screen.getByRole("progressbar")).toHaveAttribute("value", "100");
  page.rerender(
    <CommunityComputeView
      controls={{
        ...api,
        status: { ...api.status, download: { received: 120, total: null } },
      }}
    />,
  );
  expect(screen.getByRole("progressbar")).not.toHaveAttribute("value");
});
it("shows the map from six contributors and supports keyboard territory details", async () => {
  const snapshot = SMALL_COMPANY_COMMUNITY_COMPUTE_FIXTURE.snapshot;
  const page = render(
    <CommunityComputeView
      snapshot={{ ...snapshot, contributorMemberCount: 5 }}
      preview
    />,
  );
  expect(
    screen.queryByRole("region", { name: "Community compute map" }),
  ).toBeNull();
  page.rerender(
    <CommunityComputeView
      snapshot={{ ...snapshot, contributorMemberCount: 6 }}
      preview
    />,
  );
  expect(
    screen.getByRole("region", { name: "Community compute map" }),
  ).toBeVisible();
  const territory = screen
    .getAllByRole("button")
    .find((element) => element.tagName.toLowerCase() === "g");
  if (!territory) throw new Error("Missing territory");
  fireEvent.focus(territory);
  fireEvent.keyDown(territory, { key: "Enter" });
  expect(territory).toHaveAttribute("aria-pressed", "true");
  fireEvent.blur(territory);
  expect(
    screen
      .getByRole("region", { name: "Community compute map" })
      .querySelector('[aria-live="polite"]'),
  ).not.toHaveTextContent("Hover, focus or select");
  fireEvent.keyDown(territory, { key: "Escape" });
  expect(territory).toHaveAttribute("aria-pressed", "false");
});

it("cancels startup and fences its late completion behind Stop", async () => {
  const starting = deferred();
  const stopping = deferred();
  const api = controls({
    start: vi.fn(() => starting.promise),
    stop: vi.fn(() => stopping.promise),
  });
  const view = render(<CommunityComputeView controls={api} />);
  fireEvent.click(screen.getByRole("switch"));
  await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
  view.rerender(
    <CommunityComputeView
      controls={{
        ...api,
        status: { state: "starting", mode: "serve", modelId: "local-model" },
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel startup" }));
  await waitFor(() => expect(api.stop).toHaveBeenCalledOnce());
  await act(async () => starting.resolve());
  expect(screen.getByText("Stopping shared compute…")).toBeVisible();
  await act(async () => stopping.resolve());
});

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComputeActivity } from "./ComputeActivity";

afterEach(cleanup);
it("sends the latest narrow status after load and update without native authority", () => {
  const first = {
    available: true,
    generation: 2,
    lifecycle: { state: "ready" },
    usage: { tokensServed: 120, inflight: 1, tokensPerSecond: 5, peers: 2 },
  };
  const view = render(<ComputeActivity status={first} />);
  const frame = screen.getByTitle(
    "Shared-compute bee visualization",
  ) as HTMLIFrameElement;
  expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  if (!frame.contentWindow) throw Error("Missing frame");
  const post = vi.spyOn(frame.contentWindow, "postMessage");
  fireEvent.load(frame);
  expect(post).toHaveBeenLastCalledWith(
    {
      type: "buzz-mesh-activity",
      status: { generation: 2, state: "running", usage: first.usage },
    },
    "*",
  );
  view.rerender(
    <ComputeActivity
      status={{
        ...first,
        generation: 3,
        lifecycle: { state: "starting" },
        usage: null,
      }}
    />,
  );
  expect(post).toHaveBeenLastCalledWith(
    {
      type: "buzz-mesh-activity",
      status: { generation: 3, state: "starting", usage: null },
    },
    "*",
  );
  fireEvent.load(frame);
  expect(post).toHaveBeenLastCalledWith(
    {
      type: "buzz-mesh-activity",
      status: { generation: 3, state: "starting", usage: null },
    },
    "*",
  );
  view.unmount();
  expect(frame).not.toBeInTheDocument();
});

it("renders the supplied activity cards without inventing missing counters", () => {
  render(
    <ComputeActivity
      status={{
        available: true,
        lifecycle: { state: "ready" },
        usage: { tokensServed: 120, inflight: 0, tokensPerSecond: 5, peers: 2 },
      }}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "Shared-compute activity" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Output tokens").nextElementSibling,
  ).toHaveTextContent("120");
  expect(
    screen.getByText("Completed requests").nextElementSibling,
  ).toHaveTextContent("—");
  expect(
    screen.getByText("Other sharing nodes").nextElementSibling,
  ).toHaveTextContent("—");
  expect(screen.getByText("Standby")).toBeInTheDocument();
});

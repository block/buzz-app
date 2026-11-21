// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWorkStops } from "./use-work-stops";
import type { WorkStop } from "./work-stop";

const notify = vi.hoisted(() => vi.fn());
vi.mock("../../shared/design-system/ui/Toast", () => ({
  useToastNotification: () => notify,
}));
afterEach(() => {
  cleanup();
  notify.mockClear();
});

it("reports a rejected Stop even after its indicator retires", async () => {
  let reject!: (error: Error) => void;
  const control: WorkStop = {
    key: "request",
    lifecycle: true,
    interrupt: () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  };
  function Indicator() {
    const { stop } = useWorkStops([control]);
    return (
      <button type="button" onClick={() => void stop(control, "Agent")}>
        Stop
      </button>
    );
  }
  const view = render(<Indicator />);
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  view.unmount();
  await act(async () => reject(new Error("Connection lost")));
  expect(notify).toHaveBeenCalledExactlyOnceWith(
    "Couldn’t stop Agent. Connection lost",
    "error",
  );
});

it("pauses the queue before interrupting, without waiting for the pause to save", async () => {
  const order: string[] = [];
  const control: WorkStop = {
    key: "request",
    lifecycle: true,
    pauseQueue: () => {
      order.push("pause");
      return new Promise<void>(() => {});
    },
    interrupt: async () => {
      order.push("interrupt");
    },
  };
  function Indicator() {
    const { stop } = useWorkStops([control]);
    return (
      <button type="button" onClick={() => void stop(control, "Agent")}>
        Stop
      </button>
    );
  }
  render(<Indicator />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  });
  expect(order).toEqual(["pause", "interrupt"]);
  expect(notify).toHaveBeenCalledExactlyOnceWith("Stopped Agent", "success");
});

it("reports a failed pause save separately from a successful Stop", async () => {
  const interrupt = vi.fn(async () => {});
  const control: WorkStop = {
    key: "request",
    lifecycle: true,
    pauseQueue: () => {
      throw new Error("Locks unavailable");
    },
    interrupt,
  };
  function Indicator() {
    const { stop } = useWorkStops([control]);
    return (
      <button type="button" onClick={() => void stop(control, "Agent")}>
        Stop
      </button>
    );
  }
  render(<Indicator />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  });
  expect(interrupt).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledWith("Stopped Agent", "success");
  expect(notify).toHaveBeenCalledWith(
    "Queue paused in this window only. Couldn’t save the pause, so other windows or a restart may not keep it.",
    "error",
  );
});

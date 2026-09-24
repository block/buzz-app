// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  act,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentControl } from "./control";
import { controlFixture } from "./control-testing";
import { AgentWakeNotice } from "./AgentWakeNotice";
afterEach(cleanup);
it("failed automatic start is visible and dismissible without claiming the message failed", async () => {
  const fixture = controlFixture();
  fixture.agent.status = "stopped";
  vi.spyOn(fixture.host, "action").mockRejectedValue(
    "Stop old Buzz before starting agents here.",
  );
  const control = createAgentControl(fixture.host);
  render(<AgentWakeNotice control={control} />, { wrapper: ToastProvider });
  await act(() =>
    control.prepareMention(
      [fixture.agent.pubkey],
      fixture.agent.relayUrl,
      123,
      new AbortController().signal,
    )(),
  );
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "Message sent, but Fixture agent could not start",
  );
  expect(screen.getByRole("dialog")).toHaveTextContent("Stop old Buzz");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss agent notice" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  control.dispose();
});

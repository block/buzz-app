// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { Panel } from "../../features/panels/service";
import { apply } from "./index";

function register(available = false) {
  const panels: Panel[] = [];
  apply({
    panels: { register: (panel: Panel) => panels.push(panel) },
    browser: {
      available,
      View: ({ url }: { url: string }) => <span>{url}</span>,
    },
  } as unknown as Parameters<typeof apply>[0]);
  const [start, prototype] = panels;
  if (!start || !prototype) throw new Error("Missing Preview panels");
  return { start, prototype };
}

it("keeps invalid input and sends a bare local URL through the host", async () => {
  const { start } = register();
  const Start = start.component;
  const push = vi.fn(() => true);
  render(
    <Start
      target="buzz:preview"
      close={vi.fn()}
      context={{
        channelId: "example",
        canOpen: () => true,
        open: () => false,
        push,
      }}
    />,
  );
  const input = screen.getByRole("textbox", { name: "Local address" });
  fireEvent.change(input, { target: { value: "https://example.org" } });
  fireEvent.click(screen.getByRole("button", { name: "Open preview" }));
  expect(push).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("localhost");
  expect(input).toHaveValue("https://example.org");
  fireEvent.change(input, { target: { value: "localhost:3000/demo" } });
  await userEvent.type(input, "{Enter}");
  expect(push).toHaveBeenCalledWith("http://localhost:3000/demo");
});

it("claims loopback links and leaves unrelated or credentialed links alone", () => {
  const { prototype } = register();
  expect(prototype.matches("http://127.0.0.1:3000")).toBe(true);
  expect(prototype.matches("https://[::1]:3000/")).toBe(true);
  expect(prototype.matches("https://example.org")).toBe(false);
  expect(prototype.matches("http://user@localhost:3000")).toBe(false);
  expect(prototype.matches("file://localhost/index.html")).toBe(false);
});

it("renders local pages through the native view when the host provides it", () => {
  const Prototype = register(true).prototype.component;
  render(<Prototype close={vi.fn()} target="http://localhost:3000/" />);
  expect(screen.getByText("http://localhost:3000/")).toBeVisible();
});

it("offers the system browser link when the native view is unavailable", () => {
  const Prototype = register().prototype.component;
  render(<Prototype close={vi.fn()} target="http://localhost:3000/" />);
  expect(
    screen.getByRole("link", { name: "Open prototype in browser" }),
  ).toHaveAttribute("href", "http://localhost:3000/");
});

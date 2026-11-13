// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  ConnectionFailed,
  connectionFailureAction,
  connectionFailureText,
} from "./ConnectionFailed";
import type { RelaySnapshot } from "./service";

afterEach(cleanup);
const error = {
  kind: "connection",
  details: "ReadError: Relay read failed (502)",
} as const;
const view = (
  connection: Parameters<typeof ConnectionFailed>[0]["connection"],
) => {
  const relay = { tryAgain: vi.fn() };
  render(<ConnectionFailed connection={connection} relay={relay} />);
  return relay;
};

it("says it can't connect and offers Try again, without the raw failure", async () => {
  const relay = view({ error });
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Can’t connect" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Check your connection, then try again."),
  ).toBeInTheDocument();
  // The raw text is for diagnostics, with no Details disclosure.
  expect(screen.queryByText(/ReadError|502/)).toBeNull();
  expect(screen.queryByText("Details")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(relay.tryAgain).toHaveBeenCalledOnce();
});

it("says it keeps trying while the connection retries on its own", () => {
  view({ error, retrying: true });
  expect(
    screen.getByText("Check your connection. We’ll keep trying."),
  ).toBeInTheDocument();
});

it("offers Check for updates, not Try again, when the community's answer can't be used", async () => {
  const openUpdates = vi.fn();
  const relay = { tryAgain: vi.fn() };
  render(
    <ConnectionFailed
      connection={{
        error: {
          kind: "unusable",
          details: "ReadError: Relay response is not an event array",
        },
      }}
      relay={relay}
      openUpdates={openUpdates}
    />,
  );
  const alert = screen.getByRole("alert");
  // Its only action is Check for updates, so the sentence neither asks to
  // try again nor says an update fixes it.
  expect(alert).toHaveTextContent(
    "Can’t connectBuzz couldn’t connect to this community.",
  );
  expect(alert).not.toHaveTextContent(
    /try again|Check your connection|Updating Buzz|event array/i,
  );
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Check for updates" }),
  );
  expect(openUpdates).toHaveBeenCalledOnce();
  expect(relay.tryAgain).not.toHaveBeenCalled();
  expect(screen.queryByText("Details")).toBeNull();
});

it("explains a refusal with no Try again", () => {
  view({ error, denied: true, refusal: "access" });
  expect(
    screen.getByRole("heading", {
      name: "You don’t have access to this community",
    }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("Details")).toBeNull();
});

it("gives one sentence for pages that say it in their own status line", () => {
  const sentence = (connection: Partial<RelaySnapshot>) =>
    connectionFailureText(connection);
  expect(sentence({})).toBe("Check your connection, then try again.");
  expect(sentence({ retrying: true })).toBe(
    "Check your connection. We’ll keep trying.",
  );
  expect(sentence({ denied: true, refusal: "sign-in" })).not.toMatch(
    /connection/,
  );
  // As the card says it, beside Check for updates: no "try again".
  expect(sentence({ error: { kind: "unusable", details: "x" } })).toBe(
    "Buzz couldn’t connect to this community.",
  );
});

it("offers the card's action beside that sentence", async () => {
  const relay = { tryAgain: vi.fn() };
  const openUpdates = vi.fn();
  const action = (connection: Partial<RelaySnapshot>) => {
    cleanup();
    render(
      <div>
        {connectionFailureAction({
          connection: { status: "error", ...connection },
          relay,
          openUpdates,
        })}
      </div>,
    );
    return screen.queryAllByRole("button").map((button) => button.textContent);
  };
  expect(action({ error })).toEqual(["Retry connection"]);
  await userEvent.click(screen.getByRole("button"));
  expect(relay.tryAgain).toHaveBeenCalledOnce();
  expect(action({ error: { kind: "unusable", details: "x" } })).toEqual([
    "Check for updates",
  ]);
  await userEvent.click(screen.getByRole("button"));
  expect(openUpdates).toHaveBeenCalledOnce();
  expect(relay.tryAgain).toHaveBeenCalledOnce();
  // A refusal's notice offers the fix; a connection that hasn't failed, nothing.
  expect(action({ error, denied: true })).toEqual([]);
  expect(action({ status: "connecting" })).toEqual([]);
  expect(
    connectionFailureAction({
      connection: {
        status: "error",
        error: { kind: "unusable", details: "x" },
      },
      relay,
    }),
  ).toBeUndefined();
});

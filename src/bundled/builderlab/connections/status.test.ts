import { expect, it } from "vitest";
import {
  connectionLabel,
  connectionsPage,
  connectionStatus,
  sortConnections,
} from "./status";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

it("asks for renewal within a week of a known end", () => {
  const at = (expiresAt?: number, expired = false) =>
    connectionStatus(
      { name: "x", expired, ...(expiresAt ? { expiresAt } : {}) },
      NOW,
    );
  expect(at()).toEqual({ kind: "connected" });
  expect(at(NOW + 8 * DAY)).toEqual({ kind: "connected" });
  expect(at(NOW + 3 * DAY + 1)).toEqual({
    kind: "expiring",
    label: "Expires in 3 days",
  });
  expect(at(NOW + DAY + 1)).toEqual({
    kind: "expiring",
    label: "Expires tomorrow",
  });
  expect(at(NOW + 1)).toEqual({ kind: "expiring", label: "Expires today" });
  expect(at(NOW)).toEqual({ kind: "expired" });
  expect(at(undefined, true)).toEqual({ kind: "expired" });
});

it("lists connections that need attention first", () => {
  expect(
    sortConnections(
      [
        { name: "a", expired: false },
        { name: "b", expiresAt: NOW + DAY, expired: false },
        { name: "c", expired: true },
      ],
      NOW,
    ).map(({ name }) => name),
  ).toEqual(["c", "b", "a"]);
});

it("names a connection from its extension and links to its sign-in", () => {
  expect(connectionLabel("google-calendar")).toBe("Google Calendar");
  expect(connectionLabel("block_sts")).toBe("Block Sts");
  expect(connectionsPage("https://builderlab.example/api/goose", "jira")).toBe(
    "https://builderlab.example/connections?connection=jira",
  );
});

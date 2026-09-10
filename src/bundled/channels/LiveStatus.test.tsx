import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RelaySession } from "../../features/relay/session";
import { LiveStatus } from "./LiveStatus";

type Snapshot = ReturnType<RelaySession["live"]["snapshot"]>;
const channel = {
  id: "channel:a",
  channelId: "a",
  status: "live",
  replay: "unknown",
} as const;
const base: Snapshot = {
  status: "connected",
  routes: [channel],
  roster: { state: "verified" },
  heads: [],
};
function render(
  patch: Partial<Snapshot> = {},
  partialRoster = false,
  diagnostics = false,
) {
  const snapshot: Snapshot = { ...base, ...patch };
  const live = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
  };
  return renderToStaticMarkup(
    <LiveStatus
      live={live}
      channelId="a"
      partialRoster={partialRoster}
      diagnostics={diagnostics}
    />,
  );
}
it.each<Partial<Snapshot>>([
  {},
  { status: "connecting", routes: [] },
  { routes: [] },
  { routes: [{ ...channel, status: "pending" }] },
  {
    routes: [channel, { id: "profiles", status: "pending", replay: "unknown" }],
  },
  { heads: [{ channelId: "a", state: "pending" }] },
  { heads: [{ channelId: "a", state: "deferred" }] },
])(
  "does not turn ordinary setup into a yellow recovery warning: %j",
  (patch) => {
    expect(render(patch)).toBe("");
  },
);
it("reports clean connection progress in diagnostics without a retry action", () => {
  expect(
    render({ routes: [{ ...channel, status: "pending" }] }, false, true),
  ).toContain("connecting");
  expect(render({}, false, true)).toContain("stream established");
  expect(render({ status: "connecting" }, false, true)).not.toContain("button");
});
it.each<Partial<Snapshot>>([
  { status: "error" },
  { status: "retrying" },
  { status: "unavailable" },
  { error: "Socket refused" },
  { routes: [{ ...channel, status: "limited" }] },
  { routes: [{ ...channel, status: "error" }] },
  { heads: [{ channelId: "a", state: "error", error: "Head read failed" }] },
  { roster: { state: "error", error: "Roster refused" } },
  { roster: { state: "deferred" } },
])("retains recovery for degraded coverage or failures: %j", (patch) => {
  expect(render(patch)).toContain("Retry live updates");
});
it.each(["channel", "global"])(
  "keeps bounded pending %s quota recovery in Diagnostics only",
  (owner) => {
    const error = "rate-limited: quota exceeded; retry in 2s";
    const routes: Snapshot["routes"] =
      owner === "channel"
        ? [{ ...channel, status: "pending", error }]
        : [
            channel,
            { id: "profiles", status: "pending", replay: "unknown", error },
          ];
    expect(render({ routes })).toBe("");
    const diagnostics = render({ routes }, false, true);
    expect(diagnostics).toContain("recovering automatically");
    expect(diagnostics).toContain(`Last rejection: ${error}`);
    expect(diagnostics).not.toContain("stream established");
  },
);
const quota = "rate-limited: quota exceeded; retry in 4s";
const recovering = { ...channel, status: "pending", error: quota } as const;
it.each<Partial<Snapshot>>([
  { error: "Socket control failed" },
  { status: "retrying" },
  { roster: { state: "error", error: quota } },
  { heads: [{ channelId: "a", state: "error", error: `ReadError: ${quota}` }] },
  {
    routes: [
      recovering,
      {
        id: "profiles",
        status: "error",
        replay: "unknown",
        error: "Profile stream stopped",
      },
    ],
  },
  { routes: [{ ...channel, status: "error", error: quota }] },
  {
    routes: [
      {
        ...channel,
        status: "pending",
        error: "rate-limited: shared admission unavailable",
      },
    ],
  },
  {
    routes: [
      {
        ...channel,
        status: "pending",
        error: "rate-limited: quota exceeded; retry in 61s",
      },
    ],
  },
  {
    routes: [
      { ...channel, status: "pending", error: "rate-limited: quota exceeded" },
    ],
  },
])(
  "does not hide actionable or unsupported failures behind automatic recovery: %j",
  (patch) => {
    const html = render({ routes: [recovering], ...patch });
    expect(html).toContain("Retry live updates");
    expect(html).not.toContain("retry in 4s");
  },
);
it("a recovering global cannot hide a selected channel failure", () => {
  expect(
    render({
      routes: [
        { ...channel, status: "error", error: "Selected stream stopped" },
        { id: "profiles", status: "pending", replay: "unknown", error: quota },
      ],
    }),
  ).toContain("Selected stream stopped");
});
it("keeps partial roster coverage visible even with healthy established routes", () => {
  expect(render({}, true)).toContain("Some channels are missing");
  expect(render({}, true)).toContain("Retry live updates");
  expect(render({ routes: [recovering] }, true)).toContain(
    "Some channels are missing",
  );
});

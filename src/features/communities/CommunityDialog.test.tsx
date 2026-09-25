// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CommunityDialog } from "./CommunityDialog";
import type { Communities } from "./service";

vi.mock("./api", async (actual) => ({
  ...(await actual<typeof import("./api")>()),
  inspectProfile: async () => {
    throw new Error("not admitted");
  },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("names exact relay claim refusals and keeps other failures generic", async () => {
  const user = userEvent.setup();
  let refusal = "invite_exhausted";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const route = String(url).split("/").at(-1);
      if (route === "register") return Response.json({ id: "x" });
      if (route === "info") return Response.json({ name: "Fixture" });
      if (route === "claim")
        return Response.json({ error: refusal }, { status: 403 });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const communities = {
    snapshot: () => ({ status: "ready", profile: { name: "", picture: "" } }),
  } as unknown as Communities;
  render(
    <CommunityDialog communities={communities} mode="join" close={() => {}} />,
  );
  await user.type(screen.getByLabelText("Relay URL"), "wss://relay.example");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.type(
    await screen.findByLabelText("Invite code (if required)"),
    "v2.abc",
  );
  for (const [code, shown] of [
    [
      "invite_exhausted",
      "This invite has no uses left. Ask a community admin for a new one.",
    ],
    [
      "invite_expired",
      "This invite has expired. Ask a community admin for a new one.",
    ],
    ["invite_invalid", "This invite code is not valid for this community."],
    ["Relay request failed (403)", "Relay request failed (403)"],
  ] as const) {
    refusal = code;
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(shown);
  }
});

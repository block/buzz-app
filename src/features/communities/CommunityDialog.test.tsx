// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CommunityDialog } from "./CommunityDialog";
import type { Communities } from "./service";

const api = vi.hoisted(() => ({
  inspectProfile: vi.fn<typeof import("./api").inspectProfile>(),
  publishProfile: vi.fn<typeof import("./api").publishProfile>(),
}));
api.inspectProfile.mockRejectedValue(new Error("not admitted"));
api.publishProfile.mockResolvedValue();
vi.mock("./api", async (actual) => ({
  ...(await actual<typeof import("./api")>()),
  inspectProfile: api.inspectProfile,
  publishProfile: api.publishProfile,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("publishes a description-only edit to an existing community profile", async () => {
  api.inspectProfile.mockResolvedValueOnce({
    exists: true,
    existing: { name: "Fixture", about: "Before" },
    profile: { name: "Fixture", picture: "", about: "Before" },
  });
  const user = userEvent.setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const route = String(url).split("/").at(-1);
      if (route === "register") return Response.json({ id: "x" });
      if (route === "info") return Response.json({ name: "Fixture" });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const communities = {
    snapshot: () => ({
      status: "ready",
      profile: { name: "Local", picture: "" },
    }),
    joined: vi.fn(),
  } as unknown as Communities;
  render(
    <CommunityDialog communities={communities} mode="join" close={() => {}} />,
  );
  await user.type(screen.getByLabelText("Relay URL"), "wss://relay.example");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  const description = await screen.findByLabelText(
    "Profile description (optional)",
  );
  await user.clear(description);
  await user.type(description, "After");
  await user.click(
    screen.getByRole("button", { name: "Publish profile & open" }),
  );
  expect(api.publishProfile).toHaveBeenCalledWith(
    "https://relay.example",
    { name: "Fixture", picture: "", about: "After" },
    { name: "Fixture", about: "Before" },
  );
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

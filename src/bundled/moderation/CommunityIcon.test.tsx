// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayData } from "../../features/relay/service";
import { CommunityIcon } from "./CommunityIcon";

const published = vi.hoisted(() => ({ icon: "" as string | undefined }));
vi.mock("../../features/communities/community-icon", () => ({
  fetchCommunityPresentation: async () => ({ publishedIcon: published.icon }),
}));
const setCommunityIcon = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ setCommunityIcon }));

const connection = {
  status: "ready",
  generation: 1,
  scope: `https://primary.example:${"0".repeat(64)}`,
};
const relay = {
  snapshot: () => connection,
  subscribe: () => () => {},
} as unknown as RelayData;
const ICON = "data:image/png;base64,AAAA";

afterEach(() => {
  cleanup();
  setCommunityIcon.mockReset();
});

it("removes the icon and shows what the community now publishes", async () => {
  published.icon = ICON;
  setCommunityIcon.mockImplementation(async (_community, icon: string) => {
    published.icon = icon || undefined;
  });
  render(
    <CommunityIcon relay={relay} communityName="Hive" active={() => true} />,
  );
  expect(await screen.findByText("Icon set")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Remove icon" }));
  expect(await screen.findByText("Icon removed.")).toBeVisible();
  expect(setCommunityIcon).toHaveBeenCalledWith("https://primary.example", "");
  expect(screen.getByText("No icon")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Remove icon" })).toBeNull();
});

it("keeps the published icon when the relay refuses the change", async () => {
  published.icon = ICON;
  setCommunityIcon.mockRejectedValue(
    new Error("invalid: actor not authorized: must be admin or owner"),
  );
  render(
    <CommunityIcon relay={relay} communityName="Hive" active={() => true} />,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Remove icon" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "invalid: actor not authorized: must be admin or owner",
  );
  expect(screen.getByText("Icon set")).toBeVisible();
});

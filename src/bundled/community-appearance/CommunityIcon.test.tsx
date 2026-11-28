// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayData } from "../../features/relay/service";
import { CommunityIcon } from "./CommunityIcon";

const published = vi.hoisted(() => ({
  icon: "" as string | undefined,
  readFails: false,
}));
vi.mock("../../features/communities/community-icon", () => ({
  fetchCommunityPresentation: async () => {
    if (published.readFails) throw new Error("offline");
    return { publishedIcon: published.icon };
  },
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
  published.readFails = false;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
  expect(screen.getByRole("button", { name: "Choose image…" })).toHaveFocus();
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

it("reports an accepted change even when the readback fails", async () => {
  published.icon = ICON;
  setCommunityIcon.mockImplementation(async () => {
    published.readFails = true;
  });
  render(
    <CommunityIcon relay={relay} communityName="Hive" active={() => true} />,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Remove icon" }),
  );
  expect(await screen.findByText("Icon removed.")).toBeVisible();
  expect(screen.getByText("No icon")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("offers a retry when the current icon can't be read", async () => {
  published.icon = ICON;
  published.readFails = true;
  render(
    <CommunityIcon relay={relay} communityName="Hive" active={() => true} />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn't load the current icon.",
  );
  expect(screen.getByText("Icon unknown")).toBeVisible();
  published.readFails = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(screen.getByRole("button", { name: "Choose image…" })).toHaveFocus();
  expect(await screen.findByText("Icon set")).toBeVisible();
});

it("starts no write when the card closes while an image decodes", async () => {
  let decoded = (_: unknown) => {};
  vi.stubGlobal(
    "createImageBitmap",
    () => new Promise((resolve) => (decoded = resolve)),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage() {},
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(ICON);
  let open = true;
  render(
    <CommunityIcon relay={relay} communityName="Hive" active={() => open} />,
  );
  await userEvent.upload(
    screen.getByLabelText("Community icon image"),
    new File(["x"], "icon.png", { type: "image/png" }),
  );
  open = false;
  decoded({ width: 1, height: 1 });
  await new Promise((resolve) => setTimeout(resolve));
  expect(setCommunityIcon).not.toHaveBeenCalled();
});

it("starts fresh when the selected community changes", async () => {
  published.icon = ICON;
  setCommunityIcon.mockImplementation(async (_community, icon: string) => {
    published.icon = icon || undefined;
  });
  let current = connection;
  const listeners = new Set<() => void>();
  const switching = {
    snapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as RelayData;
  render(
    <CommunityIcon
      relay={switching}
      communityName="Hive"
      active={() => true}
    />,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Remove icon" }),
  );
  expect(await screen.findByText("Icon removed.")).toBeVisible();
  published.icon = ICON;
  current = { ...connection, scope: `https://other.example:${"0".repeat(64)}` };
  act(() => {
    for (const listener of listeners) listener();
  });
  expect(await screen.findByText("Icon set")).toBeVisible();
  expect(screen.queryByText("Icon removed.")).toBeNull();
});

it("keeps a transparent icon's alpha when WebKit can only encode PNG", async () => {
  vi.stubGlobal("createImageBitmap", async () => ({ width: 256, height: 256 }));
  const fillRect = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage() {},
    fillRect,
  } as unknown as CanvasRenderingContext2D);
  // Like WKWebView: WebP falls back to PNG, and the 256 px PNG is too large.
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
    function (this: HTMLCanvasElement, type?: string) {
      if (type === "image/jpeg") return "data:image/jpeg;base64,AAAA";
      return `data:image/png;base64,${this.width === 256 ? "A".repeat(49_152) : "AAAA"}`;
    },
  );
  render(
    <CommunityIcon relay={relay} communityName="Hive" active={() => true} />,
  );
  await userEvent.upload(
    screen.getByLabelText("Community icon image"),
    new File(["x"], "icon.png", { type: "image/png" }),
  );
  expect(await screen.findByText("Icon updated.")).toBeVisible();
  expect(setCommunityIcon).toHaveBeenCalledWith(
    "https://primary.example",
    "data:image/png;base64,AAAA",
  );
  expect(fillRect).not.toHaveBeenCalled();
});

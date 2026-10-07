// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { afterEach, expect, it, vi } from "vitest";
import { CredentialAccess, type CredentialGrant } from "./CredentialAccess";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(), invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
});

const grant: CredentialGrant = {
  consumer: "example.adapter",
  consumerName: "Goose adapter",
  provider: "loganj.jev",
  providerName: "Jev",
  name: "api-key",
};

it("lists saved Always Allow answers and revokes one", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke)
    .mockResolvedValueOnce([grant])
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce([]);
  render(<CredentialAccess revision={1} />);
  expect(
    await screen.findByText("Can use “api-key” from Jev"),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Revoke Goose adapter access to api-key from Jev",
    }),
  );
  await vi.waitFor(() =>
    expect(screen.queryByText("Credential access")).not.toBeInTheDocument(),
  );
  expect(invoke).toHaveBeenNthCalledWith(2, "plugin_secret_revoke", {
    consumer: "example.adapter",
    provider: "loganj.jev",
    name: "api-key",
  });
  expect(invoke).toHaveBeenNthCalledWith(3, "plugin_secret_grants");
});

it("shows nothing outside the desktop app", () => {
  vi.mocked(isTauri).mockReturnValue(false);
  const { container } = render(<CredentialAccess revision={1} />);
  expect(container).toBeEmptyDOMElement();
  expect(invoke).not.toHaveBeenCalled();
});

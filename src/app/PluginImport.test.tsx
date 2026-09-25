// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginManager } from "../plugins/manager";
import type { Catalog, ImportPreview } from "../plugins/types";
import { PluginImport } from "./PluginImport";

afterEach(cleanup);

it("shows exact declared access and changes before an enabled update", async () => {
  const preview: ImportPreview = {
    token: "preview",
    source: "/example",
    commit: null,
    warnings: [],
    candidates: [
      {
        path: "dist",
        revision: "two",
        manifest: {
          id: "example.plugin",
          name: "Example",
          apiVersion: 1,
          host: {
            commands: [
              {
                id: "check",
                program: "example-cli",
                args: ["status", "--json"],
              },
            ],
            networkOrigins: ["https://api.example.com"],
          },
        },
      },
    ],
  };
  const catalog: Catalog = {
    profile: "test",
    location: "test",
    plugins: [
      {
        manifest: {
          id: "example.plugin",
          name: "Example",
          apiVersion: 1,
          host: {
            commands: [
              {
                id: "check",
                program: "example-cli",
                args: ["status", "--brief"],
              },
            ],
            networkOrigins: ["https://old.example.com"],
          },
        },
        source: "external",
        enabled: true,
        revision: "one",
        previous: null,
        reloadable: false,
        error: null,
      },
    ],
  };
  const manager = {
    imports: {
      folder: vi.fn(async () => preview),
      git: vi.fn(),
      install: vi.fn(),
      discard: vi.fn(async () => {}),
    },
    installImport: vi.fn(async () => true),
  } as unknown as PluginManager;
  render(<PluginImport plugins={manager} catalog={catalog} busy={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Load from folder" }));
  await waitFor(() =>
    expect(
      screen.getByText(
        /Command check:.*example-cli.*status.*--json.*new or changed/,
      ),
    ).toBeVisible(),
  );
  expect(
    screen.getByText(/HTTPS origin: https:\/\/api.example.com.*new or changed/),
  ).toBeVisible();
  expect(
    screen.getByText(/Removed:.*--brief.*https:\/\/old.example.com/),
  ).toBeVisible();
  expect(
    screen.getByText(/stays enabled and may run immediately/),
  ).toBeVisible();
  expect(manager.installImport).not.toHaveBeenCalled();
});

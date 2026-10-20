// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginManager } from "../plugins/manager";
import type { Catalog, ImportPreview } from "../plugins/types";
import { PluginImport } from "./PluginImport";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";

afterEach(cleanup);

it("opens both sources inside Add without a duplicate safety warning, and restores focus on close", async () => {
  const user = userEvent.setup();
  const manager = {
    imports: { folder: vi.fn(), discard: vi.fn() },
  } as unknown as PluginManager;
  render(
    <PluginImport
      plugins={manager}
      catalog={{ profile: "test", location: "test", plugins: [] }}
      busy={false}
    />,
  );
  const add = screen.getByRole("button", { name: "Add" });
  expect(add).toHaveAttribute("data-size", "sm");
  expect(screen.queryByLabelText("Git or GitHub repository")).toBeNull();
  expect(screen.queryByText(/plugins aren’t sandboxed/)).toBeNull();
  fireEvent.click(add);
  const dialog = screen.getByRole("dialog", { name: "Add a plugin" });
  expect(
    within(dialog).getByLabelText("Git or GitHub repository"),
  ).toBeVisible();
  expect(within(dialog).queryByText(/plugins aren’t sandboxed/)).toBeNull();
  expect(
    within(dialog).getByRole("button", { name: "Browse plugin folder" }),
  ).toBeVisible();
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(add).toHaveFocus());
  await user.click(add);
  await user.click(document.querySelector(".buzz-dialog-backdrop") as Element);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("blocks dismissal and duplicate acquisition while loading, then discards the preview on close", async () => {
  const user = userEvent.setup();
  let resolve!: (value: ImportPreview) => void;
  const gate = new Promise<ImportPreview>((done) => {
    resolve = done;
  });
  const folder = vi.fn(() => gate);
  const discard = vi.fn(async () => {});
  const manager = { imports: { folder, discard } } as unknown as PluginManager;
  render(
    <PluginImport
      plugins={manager}
      catalog={{ profile: "test", location: "test", plugins: [] }}
      busy={false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  const dialog = screen.getByRole("dialog");
  const browse = within(dialog).getByRole("button", {
    name: "Browse plugin folder",
  });
  fireEvent.click(browse);
  try {
    expect(folder).toHaveBeenCalledTimes(1);
    expect(browse).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Close" }),
    ).toBeDisabled();
    fireEvent.click(browse);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await user.click(
      document.querySelector(".buzz-dialog-backdrop") as Element,
    );
    expect(dialog).toBeVisible();
    expect(folder).toHaveBeenCalledTimes(1);
  } finally {
    resolve({
      token: "drop-preview",
      source: "test",
      candidates: [],
      warnings: [],
      commit: null,
    });
  }
  await screen.findByRole("region", { name: "Plugin import preview" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(discard).toHaveBeenCalledWith("drop-preview"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("routes folder-drop contents through preview without installing, and rejects a loose file", async () => {
  const files = vi.fn(async () => ({
    token: "uploaded",
    source: "Dropped folder: example",
    candidates: [],
    warnings: [],
    commit: null,
  }));
  const manager = {
    imports: { files, discard: vi.fn(async () => {}) },
    installImport: vi.fn(),
  } as unknown as PluginManager;
  render(
    <PluginImport
      plugins={manager}
      catalog={{ profile: "test", location: "test", plugins: [] }}
      busy={false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  const zone = screen.getByRole("region", { name: "Add from folder" });
  const entry = {
    name: "example",
    isDirectory: true,
    createReader: () => ({
      readEntries: (done: (entries: unknown[]) => void) => done([]),
    }),
  };
  fireEvent.drop(zone, {
    dataTransfer: { items: [{ webkitGetAsEntry: () => entry }] },
  });
  await waitFor(() => expect(files).toHaveBeenCalledWith("example", []));
  await screen.findByRole("region", { name: "Plugin import preview" });
  expect(manager.installImport).not.toHaveBeenCalled();
  fireEvent.drop(zone, {
    dataTransfer: {
      items: [{ webkitGetAsEntry: () => ({ isDirectory: false }) }],
    },
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("Drop one folder");
  expect(files).toHaveBeenCalledTimes(1);
});

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
        readmeRevision: "readme-two",
        iconPngRevision: null,
        iconJpgRevision: "jpg-two",
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
            networkOrigins: [
              "https://api.example.com",
              "https://second.example.com",
            ],
            processes: [{ id: "worker", program: "example-worker" }],
            mcp: true,
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
        updateSource: { root: "/example", path: "dist" },
        error: null,
        readmeRevision: "readme-one",
        iconPngRevision: "icon-one",
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
  render(
    <PluginImport
      updateId="example.plugin"
      plugins={manager}
      catalog={catalog}
      busy={false}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Update" }));
  await screen.findByRole("region", { name: "Computer access" });
  expect(screen.getByText(/^Run example-cli/)).toBeVisible();
  expect(screen.getByText(/^Start example-worker/)).toBeVisible();
  expect(screen.getByText(/^Provide tools to local agents/)).toBeVisible();
  expect(screen.queryByRole("button", { name: /^Computer access/ })).toBeNull();
  expect(screen.getByRole("note")).toHaveTextContent(
    "beyond these declarations",
  );
  const scopes = within(
    screen.getByRole("region", { name: "Declared access changes" }),
  );
  expect(scopes.getByText("Run a program on your computer.")).toBeVisible();
  expect(scopes.getByText(/account’s full access/)).toBeVisible();
  expect(scopes.getAllByText(/HTTPS requests to this address/)).toHaveLength(3);
  expect(scopes.getByText(/Buzz’s local MCP server/)).toBeVisible();
  expect(screen.getByText(/beyond these declarations/)).toBeVisible();
  expect(
    screen.getByRole("region", { name: "Declared access changes" }),
  ).toBeVisible();
  expect(screen.queryByText(/Command check:/)).toBeNull();
  expect(screen.getByRole("button", { name: "Update" })).toHaveAttribute(
    "data-variant",
    "prominent",
  );
  fireEvent.click(screen.getByRole("button", { name: /^Run example-cli/ }));
  fireEvent.click(
    screen.getByRole("button", {
      name: /^Connect to https:\/\/api.example.com/,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: /^Removed: Connect to/ }));
  fireEvent.click(
    screen.getByRole("button", {
      name: /^Connect to https:\/\/second.example.com/,
    }),
  );
  expect(
    screen.getByRole("region", {
      name: "HTTPS origin https://second.example.com details",
    }),
  ).toHaveTextContent("https://second.example.com");
  const command = screen.getByRole("region", { name: "Command check details" });
  await waitFor(() => expect(command).toBeVisible());
  expect(command).toHaveTextContent(
    /changed.*Previously.*example-cli.*status.*--brief.*After this update.*example-cli.*status.*--json/,
  );
  expect(
    screen.getByRole("region", {
      name: "HTTPS origin https://api.example.com details",
    }),
  ).toHaveTextContent(/added.*https:\/\/api.example.com/);
  expect(
    screen.getByRole("region", {
      name: "Removed HTTPS origin https://old.example.com details",
    }),
  ).toHaveTextContent("https://old.example.com");
  expect(
    screen.getByRole("region", { name: "Removed declarations" }),
  ).toHaveTextContent("https://old.example.com");
  expect(screen.queryByRole("region", { name: "Package content" })).toBeNull();
  expect(
    screen.queryByText(/may run immediately|earlier revision to roll back/),
  ).toBeNull();
  expect(manager.installImport).not.toHaveBeenCalled();
});

it.each([
  {
    source: "/plugins/example",
    path: "dist",
    commit: null,
    location: "/plugins/example/dist",
  },
  {
    source: "/plugins/example/",
    path: "dist/nested",
    commit: null,
    location: "/plugins/example/dist/nested",
  },
  { source: "/", path: "dist", commit: null, location: "/dist" },
  {
    source: "C:\\plugins\\example",
    path: "dist/nested",
    commit: null,
    location: "C:\\plugins\\example\\dist\\nested",
  },
  {
    source: "Dropped folder: example",
    path: "dist",
    commit: null,
    location: "Dropped folder: example/dist",
  },
  {
    source: "https://github.com/example/plugins",
    path: "dist",
    commit: "abc",
    location: "https://github.com/example/plugins · dist",
  },
  {
    source: "/plugins/example",
    path: ".",
    commit: null,
    location: "/plugins/example",
  },
])(
  "shows source locations in choices, then only access in review for $source and $path",
  async ({ source, path, commit, location }) => {
    const preview: ImportPreview = {
      token: "preview",
      source,
      commit,
      warnings: [],
      candidates: [
        {
          path,
          manifest: { id: "example.plugin", name: "Example", apiVersion: 1 },
          revision: "one",
        },
        {
          path: "other",
          manifest: { id: "example.other", name: "Other", apiVersion: 1 },
          revision: "other",
        },
      ],
    };
    const manager = {
      imports: {
        folder: vi.fn(async () => preview),
        discard: vi.fn(async () => {}),
      },
    } as unknown as PluginManager;
    render(
      <PluginImport
        plugins={manager}
        catalog={{ profile: "test", location: "test", plugins: [] }}
        busy={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Browse plugin folder" }),
    );
    const choice = await screen.findByRole("radio", { name: "Example" });
    expect(choice).toHaveAccessibleDescription(`${location} · example.plugin`);
    fireEvent.click(choice);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.queryByText("Example", { exact: true })).toBeNull();
    expect(screen.queryByText("example.plugin", { exact: true })).toBeNull();
    expect(screen.queryByText(/^Source:/)).toBeNull();
    expect(screen.queryByText(/^Commit:/)).toBeNull();
    expect(
      screen.getByRole("region", { name: "Computer access" }),
    ).toBeVisible();
    expect(screen.queryByText(/^Folder:/)).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Skipped folders" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Install plugin" }),
    ).toBeEnabled();
  },
);

it("separates choosing from access review and restores the chosen folder on Back", async () => {
  const user = userEvent.setup();
  const manifest = {
    id: "example.plugin",
    name: "Example",
    apiVersion: 1,
  } as const;
  const preview: ImportPreview = {
    token: "steps",
    source: "/plugins/example",
    commit: null,
    warnings: [],
    candidates: [".", "dist"].map((path) => ({
      path,
      manifest,
      revision: path,
    })),
  };
  const discard = vi.fn(async () => {});
  const installImport = vi.fn(async () => true);
  const manager = {
    imports: { folder: vi.fn(async () => preview), discard },
    installImport,
    change: vi.fn(async () => true),
  } as unknown as PluginManager;
  render(
    <PluginImport
      plugins={manager}
      catalog={{ profile: "test", location: "test", plugins: [] }}
      busy={false}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Add" }));
  await user.click(
    screen.getByRole("button", { name: "Browse plugin folder" }),
  );
  const radios = await screen.findAllByRole("radio");
  expect(radios[0]).toHaveAccessibleDescription(
    "/plugins/example · example.plugin",
  );
  expect(radios[1]).toHaveAccessibleDescription(
    "/plugins/example/dist · example.plugin",
  );
  expect(screen.queryByText("Source: /plugins/example")).toBeNull();
  expect(
    screen.getByRole("dialog", { name: "Choose a plugin" }),
  ).toHaveAccessibleDescription("Select a plugin to review before installing.");
  expect(
    screen.getByRole("radiogroup", { name: "Choose a plugin" }),
  ).toBeVisible();

  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  expect(screen.queryByRole("region", { name: "Computer access" })).toBeNull();
  await user.click(radios[1] as HTMLElement);
  expect(installImport).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Install plugin" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(
    screen.queryByRole("heading", { name: "Example", level: 3 }),
  ).toBeNull();
  expect(screen.getByRole("region", { name: "Computer access" })).toBeVisible();
  expect(screen.queryByRole("radio")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Back" }));
  const restored = screen.getAllByRole("radio");
  expect(restored[1]).toBeChecked();
  expect(restored[1]).toHaveFocus();
  expect(discard).not.toHaveBeenCalled();
  await user.click(restored[0] as HTMLElement);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Install plugin" }));
  expect(installImport).toHaveBeenCalledExactlyOnceWith("steps", ".");
});

const outputLimitUpdates = [
  { previous: undefined, next: 65536, changed: true },
  { previous: 4096, next: 1048576, changed: true },
  { previous: 65536, next: 4096, changed: true },
  { previous: 65536, next: undefined, changed: true },
  { previous: undefined, next: 4096, changed: false },
  { previous: 4096, next: undefined, changed: false },
  { previous: 65536, next: 65536, changed: false },
];
const inputLimitUpdates = [
  { previous: undefined, next: 1, changed: true },
  { previous: 1, next: 65536, changed: true },
  { previous: 65536, next: 1, changed: true },
  { previous: 65536, next: undefined, changed: true },
  { previous: undefined, next: undefined, changed: false },
  { previous: 65536, next: 65536, changed: false },
];

it.each([
  ...outputLimitUpdates.map((update) => ({
    ...update,
    kind: "output" as const,
  })),
  ...inputLimitUpdates.map((update) => ({ ...update, kind: "input" as const })),
])(
  "reviews $kind-limit-only updates from $previous to $next",
  async ({ previous, next, changed, kind }) => {
    const limit = kind === "input" ? "maxInputBytes" : "maxOutputBytes";
    const allowance = (value: number | undefined) =>
      kind === "input" && value === undefined
        ? "Input: none"
        : `${kind === "input" ? "Input" : "Output"}: up to ${value ?? 4096} bytes`;
    const command = {
      id: "tools",
      program: "agent-tools",
      args: ["list", "--json"],
    };
    const manifest = {
      id: "example.plugin",
      name: "Example",
      apiVersion: 1,
    } as const;
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
            ...manifest,
            host: {
              commands: [
                {
                  ...command,
                  ...(next === undefined ? {} : { [limit]: next }),
                },
              ],
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
            ...manifest,
            host: {
              commands: [
                {
                  ...command,
                  ...(previous === undefined ? {} : { [limit]: previous }),
                },
              ],
            },
          },
          source: "external",
          enabled: true,
          revision: "one",
          previous: null,
          reloadable: false,
          updateSource: { root: "/example", path: "dist" },
          error: null,
        },
      ],
    };
    const manager = {
      imports: {
        folder: vi.fn(async () => preview),
        discard: vi.fn(async () => {}),
      },
      installImport: vi.fn(),
    } as unknown as PluginManager;
    render(
      <PluginImport
        updateId="example.plugin"
        plugins={manager}
        catalog={catalog}
        busy={false}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Update" }));
    const access = within(
      await screen.findByRole("region", { name: "Computer access" }),
    );
    if (!changed) {
      expect(screen.getByText("No declared access changes")).toBeVisible();
      fireEvent.click(
        screen.getByRole("button", { name: "View unchanged declarations" }),
      );
    }
    fireEvent.click(screen.getByRole("button", { name: /^Run agent-tools/ }));
    const grant = screen.getByRole("region", { name: "Command tools details" });
    expect(
      screen.queryByRole("region", { name: "Package content" }),
    ).not.toBeInTheDocument();
    expect(grant).toHaveTextContent(allowance(next));
    if (changed) {
      expect(grant).toHaveTextContent("(changed)");
      expect(grant).toHaveTextContent("Previously");
      expect(grant).toHaveTextContent(allowance(previous));
      expect(grant).toHaveTextContent("After this update");
      expect(
        access.getByRole("region", { name: "Changed declarations" }),
      ).toHaveTextContent(allowance(next));
    } else {
      expect(grant).not.toHaveTextContent("(changed)");
      expect(
        access.queryByRole("region", { name: "Changed declarations" }),
      ).toBeNull();
    }
    expect(
      access.queryByRole("region", { name: "Removed declarations" }),
    ).toBeNull();
    expect(manager.installImport).not.toHaveBeenCalled();
  },
);

it("signs in only to repositories the community authorizes", async () => {
  const user = userEvent.setup();
  const preview: ImportPreview = {
    token: "preview",
    source: "repo",
    commit: null,
    warnings: [],
    candidates: [],
  };
  const git = vi.fn(async () => preview);
  const manager = {
    imports: {
      folder: vi.fn(),
      git,
      install: vi.fn(),
      discard: vi.fn(async () => {}),
    },
    installImport: vi.fn(),
  } as unknown as PluginManager;
  const buzz = `https://relay.test/git/${"a".repeat(64)}/plugins`;
  const authorizeGit = vi.fn(async (repository: string) =>
    repository.includes("/git/")
      ? { repository: buzz, token: "dG9rZW4=" }
      : null,
  );
  render(
    <PluginImport
      plugins={manager}
      catalog={{ profile: "test", location: "test", plugins: [] }}
      busy={false}
      authorizeGit={authorizeGit}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Add" }));
  const field = screen.getByLabelText("Git or GitHub repository");
  const find = screen.getByRole("button", { name: "Find plugins" });
  fireEvent.change(field, { target: { value: ` ${buzz} ` } });
  find.focus();
  await user.click(find);
  await screen.findByRole("region", { name: "Plugin import preview" });
  expect(screen.queryByRole("form", { name: "Add from Git" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Browse plugin folder" }),
  ).toBeNull();
  const back = screen.getByRole("button", { name: "Back" });
  await waitFor(() => expect(back).toHaveFocus());
  await user.click(back);
  await waitFor(() => expect(find).toHaveFocus());
  expect(field).toHaveValue(` ${buzz} `);
  expect(manager.imports?.discard).toHaveBeenCalledWith("preview");
  await waitFor(() => expect(git).toHaveBeenCalledTimes(1));
  expect(git).toHaveBeenLastCalledWith(buzz, "", "dG9rZW4=");
  fireEvent.change(field, { target: { value: "block/plugins" } });
  await waitFor(() => expect(find).toBeEnabled());
  await user.click(find);
  await waitFor(() => expect(git).toHaveBeenCalledTimes(2));
  expect(git).toHaveBeenLastCalledWith("block/plugins", "");
});

it("replaces Add with an error view and returns to the retained preview for retry", async () => {
  const preview: ImportPreview = {
    token: "retry-preview",
    source: "test",
    commit: null,
    warnings: [],
    candidates: [
      {
        path: ".",
        manifest: { id: "example.retry", name: "Retry plugin", apiVersion: 1 },
        revision: "one",
        publisher: null,
      },
    ],
  };
  let error: string | null = "Publisher mismatch";
  let finish!: (success: boolean) => void;
  const installImport = vi
    .fn()
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(false)
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
  const manager = {
    imports: {
      folder: vi.fn(async () => preview),
      discard: vi.fn(async () => {}),
    },
    snapshot: () => ({ error }),
    installImport,
    change: vi.fn(async () => true),
  } as unknown as PluginManager;
  render(
    <PluginImport
      plugins={manager}
      catalog={{ profile: "test", location: "test", plugins: [] }}
      busy={false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(screen.getByRole("button", { name: "Browse plugin folder" }));
  const dialog = screen.getByRole("dialog");
  const install = await within(dialog).findByRole("button", {
    name: "Install plugin",
  });
  expect(within(dialog).queryByRole("radio")).toBeNull();
  expect(within(dialog).queryByText("Choose a plugin folder")).toBeNull();
  expect(within(dialog).queryByText("Retry plugin")).toBeNull();
  expect(within(dialog).queryByText("example.retry")).toBeNull();
  expect(install).toHaveAttribute("data-variant", "prominent");
  install.focus();
  fireEvent.click(install);
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Publisher mismatch",
  );
  expect(
    within(dialog).queryByRole("region", { name: "Plugin import preview" }),
  ).toBeNull();
  expect(
    within(dialog).queryByRole("button", { name: "Browse plugin folder" }),
  ).toBeNull();
  const back = within(dialog).getByRole("button", { name: "Back" });
  expect(back).toHaveFocus();
  fireEvent.click(back);
  const retry = within(dialog).getByRole("button", { name: "Install plugin" });
  expect(retry).toHaveFocus();
  expect(
    within(dialog).getByRole("region", { name: "Plugin import preview" }),
  ).toBeVisible();
  error = "Persistence failed";
  fireEvent.click(retry);
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Persistence failed",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Install plugin" }),
  );
  expect(
    within(dialog).getByRole("button", { name: "Install plugin" }),
  ).toBeDisabled();
  finish(true);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(manager.change).toHaveBeenCalledWith("enable", "example.retry");
  expect(installImport.mock.calls).toEqual(
    Array(3).fill(["retry-preview", "."]),
  );
});

it("shows a rejected dropped candidate's warning beside a usable sibling preview", async () => {
  const entryFile = (name: string, size: number) => ({
    name,
    isFile: true,
    isDirectory: false,
    file: (resolve: (file: unknown) => void) =>
      resolve({
        size,
        arrayBuffer: async () => new TextEncoder().encode("{}").buffer,
      }),
  });
  const directory = (name: string, children: unknown[]) => ({
    name,
    isDirectory: true,
    isFile: false,
    createReader: () => {
      let read = false;
      return {
        readEntries: (resolve: (entries: unknown[]) => void) => {
          resolve(read ? [] : children);
          read = true;
        },
      };
    },
  });
  const files = vi.fn(async () => ({
    token: "partial",
    source: "Dropped folder",
    commit: null,
    candidates: [
      {
        path: "good",
        revision: "one",
        manifest: { id: "example.good", name: "Good plugin", apiVersion: 1 },
      },
    ],
    warnings: [],
  }));
  const manager = {
    imports: { files, discard: vi.fn(async () => {}) },
  } as unknown as PluginManager;
  render(
    <PluginImport
      plugins={manager}
      catalog={{ profile: "test", location: "test", plugins: [] }}
      busy={false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  const root = directory("plugins", [
    directory("bad", [
      entryFile("manifest.json", 2),
      entryFile("README.md", 300 * 1024),
    ]),
    directory("good", [
      entryFile("manifest.json", 2),
      entryFile("plugin.js", 2),
    ]),
  ]);
  fireEvent.drop(screen.getByRole("region", { name: "Add from folder" }), {
    dataTransfer: { items: [{ webkitGetAsEntry: () => root }] },
  });
  const warning = await screen.findByText(/bad:.*limit/);
  expect(warning).toBeVisible();
  expect(screen.getByRole("button", { name: "Install plugin" })).toBeEnabled();
  expect(files).toHaveBeenCalledWith("plugins", [
    { path: "good/manifest.json", text: "{}" },
    { path: "good/plugin.js", text: "{}" },
  ]);
});

it("Back restores source fields and focus after acquisition fails", async () => {
  const user = userEvent.setup();
  const git = vi.fn(async () => {
    throw new Error("Repository unavailable");
  });
  const manager = { imports: { git } } as unknown as PluginManager;
  render(
    <PluginImport
      plugins={manager}
      catalog={{ profile: "test", location: "test", plugins: [] }}
      busy={false}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Add" }));
  await user.type(
    screen.getByLabelText("Git or GitHub repository"),
    "https://github.com/example/plugin",
  );
  await user.type(screen.getByLabelText("Branch or tag (optional)"), "stable");
  const find = screen.getByRole("button", { name: "Find plugins" });
  await user.click(find);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Repository unavailable",
  );
  expect(screen.queryByRole("form", { name: "Add from Git" })).toBeNull();
  const back = screen.getByRole("button", { name: "Back" });
  expect(back).toHaveFocus();
  await user.click(back);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByLabelText("Git or GitHub repository")).toHaveValue(
    "https://github.com/example/plugin",
  );
  expect(screen.getByLabelText("Branch or tag (optional)")).toHaveValue(
    "stable",
  );
  expect(find).toHaveFocus();
});

it.each([true, false])(
  "closes after installing with enable preference %s",
  async (enabled) => {
    const manager = {
      imports: {
        folder: vi.fn(async () => ({
          token: "new",
          source: "/plugin",
          commit: null,
          warnings: [],
          candidates: [
            {
              path: ".",
              revision: "one",
              manifest: {
                id: "example.new",
                name: "New plugin",
                apiVersion: 1,
              },
            },
          ],
        })),
        discard: vi.fn(async () => {}),
      },
      installImport: vi.fn(async () => true),
      change: vi.fn(async () => false),
    } as unknown as PluginManager;
    const user = userEvent.setup();
    render(
      <PluginImport
        plugins={manager}
        catalog={{ profile: "test", location: "test", plugins: [] }}
        busy={false}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(
      screen.getByRole("button", { name: "Browse plugin folder" }),
    );
    const toggle = await screen.findByRole("switch", { name: "Enable plugin" });
    expect(toggle).toBeChecked();
    if (!enabled) await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Install plugin" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(manager.installImport).toHaveBeenCalledExactlyOnceWith("new", ".");
    if (enabled)
      expect(manager.change).toHaveBeenCalledExactlyOnceWith(
        "enable",
        "example.new",
      );
    else expect(manager.change).not.toHaveBeenCalled();
    expect(manager.imports?.discard).toHaveBeenCalledExactlyOnceWith("new");
  },
);

it("limits pane updates to the selected plugin without modifying the source preview", async () => {
  const preview = {
    token: "update",
    source: "/plugins",
    commit: null,
    warnings: [],
    candidates: [
      {
        path: "other",
        revision: "one",
        manifest: { id: "example.other", name: "Other", apiVersion: 1 },
      },
      {
        path: "target",
        revision: "two",
        manifest: { id: "example.target", name: "Target", apiVersion: 1 },
      },
    ],
  };
  const installed = {
    manifest: { id: "example.target", name: "Target", apiVersion: 1 as const },
    source: "external" as const,
    enabled: true,
    revision: "one",
    previous: null,
    reloadable: true,
    updateSource: { root: "/plugins", path: "target" },
    error: null,
  };
  const manager = {
    imports: {
      folder: vi.fn(async () => preview),
      discard: vi.fn(async () => {}),
    },
    installImport: vi.fn(async () => true),
    change: vi.fn(),
  } as unknown as PluginManager;
  const user = userEvent.setup();
  render(
    <PluginImport
      updateId="example.target"
      plugins={manager}
      catalog={{ profile: "test", location: "test", plugins: [installed] }}
      busy={false}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Update" }));
  const update = await screen.findByRole("button", { name: "Update" });
  expect(screen.queryByRole("radio")).toBeNull();
  expect(screen.queryByRole("switch", { name: "Enable plugin" })).toBeNull();
  await user.click(update);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(manager.installImport).toHaveBeenCalledExactlyOnceWith(
    "update",
    "target",
  );
  expect(manager.change).not.toHaveBeenCalled();
  expect(preview.candidates).toHaveLength(2);
});

it("opens installed details instead of adding another source", async () => {
  const manifest = {
    id: "example.duplicate",
    name: "Duplicate",
    apiVersion: 1 as const,
  };
  const installed = {
    manifest,
    source: "external" as const,
    enabled: false,
    revision: "one",
    previous: null,
    reloadable: true,
    error: null,
  };
  const discard = vi.fn(async () => {});
  const manager = {
    installImport: vi.fn(async () => true),
    change: vi.fn(),
    imports: {
      folder: vi.fn(async () => ({
        token: "duplicate",
        source: "/example",
        commit: null,
        warnings: [],
        candidates: [{ path: ".", revision: "two", manifest }],
      })),
      discard,
    },
  } as unknown as PluginManager;
  const openInstalled = vi.fn();
  render(
    <PluginImport
      plugins={manager}
      onOpenInstalled={openInstalled}
      catalog={{ profile: "test", location: "test", plugins: [installed] }}
      busy={false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(screen.getByRole("button", { name: "Browse plugin folder" }));
  expect(
    await screen.findByText(/This plugin is already installed/),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Install plugin" })).toBeNull();
  expect(screen.queryByText(/This plugin will stay disabled/)).toBeNull();
  expect(manager.installImport).not.toHaveBeenCalled();
  expect(manager.change).not.toHaveBeenCalled();
  discard.mockRejectedValueOnce(new Error("Discard failed"));
  fireEvent.click(screen.getByRole("button", { name: "Open in Buzz" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Discard failed");
  expect(openInstalled).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(screen.getByRole("button", { name: "Open in Buzz" }));
  await waitFor(() =>
    expect(openInstalled).toHaveBeenCalledExactlyOnceWith(manifest.id),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(manager.installImport).not.toHaveBeenCalled();
});

it("keeps install review stable while the saved catalog arrives before enabling", async () => {
  const manifest = {
    id: "example.pending",
    name: "Pending",
    apiVersion: 1 as const,
  };
  let finish!: (success: boolean) => void;
  const change = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const manager = {
    imports: {
      folder: vi.fn(async () => ({
        token: "pending",
        source: "/example",
        commit: null,
        warnings: [],
        candidates: [{ path: ".", revision: "one", manifest }],
      })),
      discard: vi.fn(async () => {}),
    },
    installImport: vi.fn(async () => true),
    change,
  } as unknown as PluginManager;
  const catalog: Catalog = { profile: "test", location: "test", plugins: [] };
  const view = render(
    <PluginImport plugins={manager} catalog={catalog} busy={false} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(screen.getByRole("button", { name: "Browse plugin folder" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Install plugin" }),
  );
  await waitFor(() => expect(change).toHaveBeenCalled());
  view.rerender(
    <PluginImport
      plugins={manager}
      catalog={{
        ...catalog,
        plugins: [
          {
            manifest,
            source: "external",
            enabled: false,
            revision: "one",
            previous: null,
            reloadable: true,
            error: null,
          },
        ],
      }}
      busy={true}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Installing plugin…");
  expect(screen.getByRole("switch", { name: "Enable plugin" })).toBeVisible();
  expect(screen.queryByText(/This plugin is already installed/)).toBeNull();
  expect(screen.queryByText(/Reading plugin folders/)).toBeNull();
  finish(true);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

const rememberedManifest = {
  id: "example.remembered",
  name: "Remembered",
  apiVersion: 1 as const,
};
const rememberedPlugin = {
  manifest: rememberedManifest,
  source: "external" as const,
  enabled: false,
  revision: "old",
  previous: null,
  reloadable: true,
  error: null,
};
const rememberedPreview = {
  token: "remembered",
  source: "/plugins",
  commit: null,
  warnings: [],
  candidates: [
    { path: "dist", revision: "new", manifest: rememberedManifest },
    { path: "alternate", revision: "alternate", manifest: rememberedManifest },
  ],
};

it("rechecks Git with fresh authorization before opening a requested row review", async () => {
  const git = vi.fn(async () => rememberedPreview);
  const handled = vi.fn();
  const manager = {
    imports: { git, discard: vi.fn(async () => {}) },
    installImport: vi.fn(),
  } as unknown as PluginManager;
  const repository = "https://git.example.com/plugins";
  const authorizeGit = vi.fn(async () => ({ repository, token: "fresh" }));
  render(
    <StrictMode>
      <PluginImport
        plugins={manager}
        catalog={{
          profile: "test",
          location: "test",
          plugins: [
            {
              ...rememberedPlugin,
              updateSource: {
                repository,
                reference: "release/one",
                path: "dist",
              },
            },
          ],
        }}
        busy={false}
        updateId={rememberedManifest.id}
        authorizeGit={authorizeGit}
        reviewRequested
        onReviewHandled={handled}
      />
    </StrictMode>,
  );
  expect(
    await screen.findByRole("dialog", { name: "Update Remembered" }),
  ).toBeVisible();
  expect(git).toHaveBeenCalledExactlyOnceWith(
    repository,
    "release/one",
    "fresh",
  );
  expect(authorizeGit).toHaveBeenCalledExactlyOnceWith(repository);
  expect(handled).toHaveBeenCalled();
  expect(manager.installImport).not.toHaveBeenCalled();
});

it.each([
  { root: "/plugins", path: "dist" },
  {
    repository: "https://git.example.com/plugins",
    reference: "release/one",
    path: "dist",
  },
])(
  "checks the remembered source and build path with a fresh review: %j",
  async (updateSource) => {
    const user = userEvent.setup();
    const manager = {
      imports: {
        folder: vi.fn(async () => rememberedPreview),
        git: vi.fn(async () => rememberedPreview),
        discard: vi.fn(async () => {}),
      },
      installImport: vi.fn(async () => true),
      change: vi.fn(),
    } as unknown as PluginManager;
    const authorizeGit = vi.fn(async (repository: string) => ({
      repository,
      token: "fresh-authorization",
    }));
    render(
      <StrictMode>
        <PluginImport
          plugins={manager}
          catalog={{
            profile: "test",
            location: "test",
            plugins: [{ ...rememberedPlugin, updateSource }],
          }}
          busy={false}
          updateId={rememberedManifest.id}
          authorizeGit={authorizeGit}
        />
      </StrictMode>,
    );
    expect(
      screen.queryByRole("button", { name: "Browse plugin folder" }),
    ).toBeNull();
    if (!("root" in updateSource))
      await user.click(
        screen.getByRole("button", { name: "Check for updates" }),
      );
    await user.click(await screen.findByRole("button", { name: "Update" }));
    expect(
      await screen.findByText(/This plugin will stay disabled/),
    ).toBeVisible();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(manager.installImport).not.toHaveBeenCalled();
    if ("root" in updateSource)
      expect(manager.imports?.folder).toHaveBeenCalledExactlyOnceWith(
        "/plugins",
      );
    else {
      expect(authorizeGit).toHaveBeenCalledExactlyOnceWith(
        updateSource.repository,
      );
      expect(manager.imports?.git).toHaveBeenCalledExactlyOnceWith(
        updateSource.repository,
        "release/one",
        "fresh-authorization",
      );
    }
    expect(
      screen.queryByRole("button", { name: "Check for updates" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(manager.installImport).toHaveBeenCalledExactlyOnceWith(
      "remembered",
      "dist",
    );
    expect(manager.change).not.toHaveBeenCalled();
  },
);

it("retries an unavailable folder automatically without offering a different source", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const folder = vi
    .fn()
    .mockRejectedValueOnce(new Error("Folder no longer exists"))
    .mockResolvedValueOnce({
      ...rememberedPreview,
      candidates: [rememberedPreview.candidates[0]],
    });
  const manager = {
    imports: { folder, discard: vi.fn(async () => {}) },
  } as unknown as PluginManager;
  render(
    <PluginImport
      plugins={manager}
      catalog={{
        profile: "test",
        location: "test",
        plugins: [
          {
            ...rememberedPlugin,
            updateSource: { root: "/moved", path: "dist" },
          },
        ],
      }}
      busy={false}
      updateId={rememberedManifest.id}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Folder no longer exists",
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Browse plugin folder" }),
  ).toBeNull();
  await act(async () => vi.advanceTimersByTime(5_000));
  expect(await screen.findByRole("button", { name: "Update" })).toBeEnabled();
  vi.useRealTimers();
  expect(folder.mock.calls).toEqual([["/moved"], ["/moved"]]);
});

it("keeps wrong-plugin sources out of a remembered-source update", async () => {
  const discard = vi.fn(async () => {});
  const manager = {
    imports: {
      folder: vi.fn(async () => ({
        ...rememberedPreview,
        candidates: [
          {
            ...rememberedPreview.candidates[0],
            manifest: { ...rememberedManifest, id: "example.wrong" },
          },
        ],
      })),
      discard,
    },
  } as unknown as PluginManager;
  render(
    <PluginImport
      plugins={manager}
      catalog={{
        profile: "test",
        location: "test",
        plugins: [
          {
            ...rememberedPlugin,
            updateSource: { root: "/plugins", path: "dist" },
          },
        ],
      }}
      busy={false}
      updateId={rememberedManifest.id}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "no longer contains this plugin",
  );
  expect(discard).toHaveBeenCalledExactlyOnceWith("remembered");
  expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
});

it("shows unchanged declarations in a separate dialog view and returns without reacquisition", async () => {
  const user = userEvent.setup();
  const host = {
    commands: [{ id: "check", program: "example-cli", args: ["status"] }],
    networkOrigins: ["https://one.example.com", "https://two.example.com"],
  };
  const manager = {
    imports: {
      folder: vi.fn(async () => ({
        ...rememberedPreview,
        candidates: [
          {
            path: "dist",
            revision: "changed-code",
            manifest: {
              ...rememberedManifest,
              host: {
                commands: [{ ...host.commands[0], maxOutputBytes: 4096 }],
                networkOrigins: [...host.networkOrigins].reverse(),
              },
            },
          },
        ],
      })),
      discard: vi.fn(async () => {}),
    },
  } as unknown as PluginManager;
  render(
    <PluginImport
      plugins={manager}
      catalog={{
        profile: "test",
        location: "test",
        plugins: [
          {
            ...rememberedPlugin,
            manifest: { ...rememberedManifest, host },
            updateSource: { root: "/plugins", path: "dist" },
          },
        ],
      }}
      busy={false}
      updateId={rememberedManifest.id}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Update" }));
  expect(await screen.findByText("No declared access changes")).toBeVisible();
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Update Remembered");
  expect(
    screen.getByRole("region", { name: "Update source" }),
  ).toHaveTextContent("Source folder/plugins/dist");
  expect(
    screen.queryByRole("region", { name: "Added declarations" }),
  ).toBeNull();
  expect(
    screen.queryByRole("region", { name: "Changed declarations" }),
  ).toBeNull();
  expect(
    screen.queryByRole("region", { name: "Removed declarations" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "All access declarations" }),
  ).toBeNull();
  expect(screen.queryByRole("region", { name: "Declared scopes" })).toBeNull();
  const view = screen.getByRole("button", {
    name: "View unchanged declarations",
  });
  await user.click(view);
  expect(screen.getByRole("dialog")).toHaveAccessibleName(
    "Unchanged declarations",
  );
  expect(screen.getByRole("dialog")).toHaveAccessibleDescription("");
  expect(screen.getByRole("button", { name: "Back" })).toHaveFocus();
  expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  expect(screen.queryByText("No declared access changes")).not.toBeVisible();
  expect(
    screen.getByRole("button", { name: /^Run example-cli/ }),
  ).toHaveAttribute("aria-expanded", "false");
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Update Remembered");
  expect(view).toHaveFocus();
  expect(screen.getByRole("note")).toHaveTextContent(
    "Only update code you trust",
  );
  expect(manager.imports?.folder).toHaveBeenCalledTimes(1);
  expect(manager.imports?.discard).not.toHaveBeenCalled();
  await user.click(view);
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Update Remembered");
  expect(view).toHaveFocus();
});

it("keeps identical packages in the pane without opening review or installing", async () => {
  const manager = {
    imports: {
      folder: vi.fn(async () => ({
        ...rememberedPreview,
        candidates: [
          { path: "dist", revision: "old", manifest: rememberedManifest },
        ],
      })),
      discard: vi.fn(async () => {}),
    },
    installImport: vi.fn(async () => true),
    change: vi.fn(),
  } as unknown as PluginManager;
  const view = render(
    <PluginImport
      plugins={manager}
      catalog={{
        profile: "test",
        location: "test",
        plugins: [
          {
            ...rememberedPlugin,
            updateSource: { root: "/plugins", path: "dist" },
          },
        ],
      }}
      busy={false}
      updateId={rememberedManifest.id}
    />,
  );
  expect(await screen.findByText("Up to date")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("No declared access changes")).toBeNull();
  expect(screen.queryByRole("note")).toBeNull();
  view.unmount();
  await waitFor(() =>
    expect(manager.imports?.discard).toHaveBeenCalledExactlyOnceWith(
      "remembered",
    ),
  );
  expect(manager.installImport).not.toHaveBeenCalled();
  expect(manager.change).not.toHaveBeenCalled();
});

it("discards a late pane check after details unmount without opening review", async () => {
  let finish!: (preview: ImportPreview) => void;
  const manager = {
    imports: {
      folder: vi.fn(
        () =>
          new Promise<ImportPreview>((resolve) => {
            finish = resolve;
          }),
      ),
      discard: vi.fn(async () => {}),
    },
    installImport: vi.fn(),
  } as unknown as PluginManager;
  const view = render(
    <PluginImport
      plugins={manager}
      catalog={{
        profile: "test",
        location: "test",
        plugins: [
          {
            ...rememberedPlugin,
            updateSource: { root: "/plugins", path: "dist" },
          },
        ],
      }}
      busy={false}
      updateId={rememberedManifest.id}
    />,
  );
  await waitFor(() => expect(manager.imports?.folder).toHaveBeenCalledTimes(1));
  view.unmount();
  await act(async () => finish(rememberedPreview));
  expect(manager.imports?.discard).toHaveBeenCalledExactlyOnceWith(
    "remembered",
  );
  expect(manager.installImport).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("does not substitute another folder with the same plugin identity", async () => {
  const manager = {
    imports: {
      folder: vi.fn(async () => ({
        ...rememberedPreview,
        candidates: [rememberedPreview.candidates[1]],
      })),
      discard: vi.fn(async () => {}),
    },
  } as unknown as PluginManager;
  render(
    <PluginImport
      plugins={manager}
      catalog={{
        profile: "test",
        location: "test",
        plugins: [
          {
            ...rememberedPlugin,
            updateSource: { root: "/plugins", path: "dist" },
          },
        ],
      }}
      busy={false}
      updateId={rememberedManifest.id}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "no longer contains this plugin",
  );
  expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  expect(manager.imports?.discard).toHaveBeenCalledExactlyOnceWith(
    "remembered",
  );
});

it("delays initial checking feedback and keeps periodic checks quiet", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  let finish!: (preview: ImportPreview) => void;
  const folder = vi.fn(
    () =>
      new Promise<ImportPreview>((resolve) => {
        finish = resolve;
      }),
  );
  const manager = {
    imports: { folder, discard: vi.fn(async () => {}) },
  } as unknown as PluginManager;
  const same = {
    ...rememberedPreview,
    candidates: [
      { path: "dist", revision: "old", manifest: rememberedManifest },
    ],
  };
  const view = render(
    <PluginImport
      plugins={manager}
      catalog={{
        profile: "test",
        location: "test",
        plugins: [
          {
            ...rememberedPlugin,
            updateSource: { root: "/plugins", path: "dist" },
          },
        ],
      }}
      busy={false}
      updateId={rememberedManifest.id}
    />,
  );
  try {
    await act(async () => {});
    expect(
      screen.queryByRole("button", { name: "Check for updates" }),
    ).toBeNull();
    expect(folder).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(199));
    expect(screen.queryByText("Checking for updates…")).toBeNull();
    await act(async () => finish(same));
    await act(async () => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Checking for updates…")).toBeNull();
    expect(screen.getByText("Up to date")).toBeVisible();

    await act(async () => vi.advanceTimersByTime(4_800));
    expect(folder).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTime(199));
    expect(screen.queryByText("Checking for updates…")).toBeNull();
    await act(async () => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Checking for updates…")).toBeNull();
    expect(screen.getByText("Up to date")).toBeVisible();
    await act(async () => finish(same));
    expect(screen.queryByText("Checking for updates…")).toBeNull();
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});

it("polls visible local folders without overlap, preserves review, and cleans up on close", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("visible");
  const same = {
    ...rememberedPreview,
    token: "same",
    candidates: [
      { path: "dist", revision: "old", manifest: rememberedManifest },
    ],
  };
  let finish!: (preview: ImportPreview) => void;
  const folder = vi
    .fn()
    .mockResolvedValueOnce(same)
    .mockImplementationOnce(
      () =>
        new Promise<ImportPreview>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ ...rememberedPreview, token: "latest" });
  const discard = vi.fn(async () => {});
  const manager = {
    imports: { folder, discard },
    installImport: vi.fn(),
  } as unknown as PluginManager;
  const props = {
    plugins: manager,
    catalog: {
      profile: "test",
      location: "test",
      plugins: [
        {
          ...rememberedPlugin,
          updateSource: { root: "/plugins", path: "dist" },
        },
      ],
    },
    busy: false,
    updateId: rememberedManifest.id,
  };
  render(<button type="button">Keep focus</button>);
  const view = render(<PluginImport {...props} />);
  try {
    await act(async () => {});
    screen.getByRole("button", { name: "Keep focus" }).focus();
    await act(async () => vi.advanceTimersByTime(4_999));
    expect(folder).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("hidden");
    await act(async () => vi.advanceTimersByTime(10_001));
    expect(folder).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    await act(async () => {
      fireEvent(document, new Event("visibilitychange"));
    });
    expect(folder).toHaveBeenCalledTimes(2);
    expect(discard).toHaveBeenCalledWith("same");
    expect(screen.getByText("Up to date")).toBeVisible();
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(folder).toHaveBeenCalledTimes(2);
    await act(async () => finish(rememberedPreview));
    expect(screen.getByRole("button", { name: "Keep focus" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(folder).toHaveBeenCalledTimes(2);
    expect(discard).not.toHaveBeenCalledWith("remembered");
    expect(manager.installImport).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }),
    );
    await act(async () => {});
    view.rerender(<PluginImport {...props} busy />);
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(folder).toHaveBeenCalledTimes(2);
    view.rerender(<PluginImport {...props} />);
    await act(async () => {
      fireEvent(window, new Event("focus"));
    });
    expect(folder).toHaveBeenCalledTimes(3);
    view.unmount();
    expect(discard).toHaveBeenCalledWith("latest");
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(folder).toHaveBeenCalledTimes(3);
  } finally {
    finish?.(rememberedPreview);
    view.unmount();
    visibility.mockRestore();
    vi.useRealTimers();
  }
});

it("keeps Git checks explicit across timer ticks and window activation", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const git = vi.fn(async () => rememberedPreview);
  const manager = {
    imports: { git, discard: vi.fn(async () => {}) },
  } as unknown as PluginManager;
  const view = render(
    <PluginImport
      plugins={manager}
      catalog={{
        profile: "test",
        location: "test",
        plugins: [
          {
            ...rememberedPlugin,
            updateSource: {
              repository: "https://git.example.com/plugins",
              reference: "",
              path: "dist",
            },
          },
        ],
      }}
      busy={false}
      updateId={rememberedManifest.id}
    />,
  );
  try {
    await act(async () => vi.advanceTimersByTime(15_000));
    await act(async () => {
      fireEvent(window, new Event("focus"));
    });
    expect(git).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await act(async () => {});
    expect(git).toHaveBeenCalledTimes(1);
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginManager } from "../plugins/manager";
import type {
  Catalog,
  ImportPreview,
  ManagedEntry,
  ManagedPlugins as Policy,
} from "../plugins/types";
import { ManagedPlugins } from "./ManagedPlugins";

afterEach(cleanup);

const commit = "0123456789abcdef0123456789abcdef01234567";
const entry = (
  state: ManagedEntry["state"],
  overrides: Partial<ManagedEntry> = {},
): ManagedEntry => ({
  id: "example.managed",
  repository: "https://example.com/plugins",
  reference: "v1",
  commit,
  path: "dist",
  state,
  ...overrides,
});
const ready = (plugins: ManagedEntry[], problems: string[] = []): Policy => ({
  status: "ready",
  path: "/data/managed-plugins.json",
  source: "Example Org",
  plugins,
  problems,
});
const manifest = {
  id: "example.managed",
  name: "Managed example",
  apiVersion: 1 as const,
};
const preview = (overrides: Partial<ImportPreview> = {}): ImportPreview => ({
  token: "preview",
  source: "https://example.com/plugins",
  commit,
  warnings: [],
  candidates: [{ path: "dist", revision: "new", manifest }],
  ...overrides,
});
const installed = {
  manifest: { ...manifest, name: "Installed example" },
  source: "external" as const,
  enabled: true,
  revision: "old",
  previous: null,
  reloadable: false,
  error: null,
};
const catalog = (plugins: Catalog["plugins"] = []): Catalog => ({
  profile: "test",
  location: "test",
  plugins,
});

function harness(options: { git?: ReturnType<typeof vi.fn> } = {}) {
  const git = options.git ?? vi.fn(async () => preview());
  const imports = { git, discard: vi.fn(async () => {}) };
  const manager = {
    imports,
    installImport: vi.fn(async () => true),
    change: vi.fn(async () => true),
    snapshot: (): { error: string | null } => ({ error: null }),
  };
  return { manager, imports, git };
}
function show(
  manager: unknown,
  managed: Policy | undefined,
  plugins: Catalog["plugins"] = [],
  extra: { busy?: boolean; strict?: boolean } = {},
) {
  const ui = (
    <ManagedPlugins
      plugins={manager as PluginManager}
      managed={managed}
      catalog={catalog(plugins)}
      busy={extra.busy ?? false}
    />
  );
  return render(extra.strict ? <StrictMode>{ui}</StrictMode> : ui);
}

it("renders nothing without a policy, in the browser, or when everything is current", () => {
  const { manager } = harness();
  const none = show(manager, undefined);
  expect(none.container).toBeEmptyDOMElement();
  none.unmount();
  const current = show(manager, ready([entry("current")]), [installed]);
  expect(current.container).toBeEmptyDOMElement();
  current.unmount();
  const web = show({ imports: undefined }, ready([entry("missing")]));
  expect(web.container).toBeEmptyDOMElement();
});

it("lists pending recommendations under their source without installing anything", () => {
  const { manager, git } = harness();
  show(
    manager,
    ready([
      entry("missing"),
      entry("outdated", { id: "example.moved" }),
      entry("other", { id: "example.other" }),
    ]),
  );
  const group = screen.getByRole("region", {
    name: "Recommended by Example Org",
  });
  expect(
    within(group).getByRole("button", {
      name: "Review and install example.managed",
    }),
  ).toBeEnabled();
  expect(
    within(group).getByRole("button", { name: "Review update example.moved" }),
  ).toBeVisible();
  expect(within(group).getByText(/Update recommended/)).toBeVisible();
  expect(
    within(group).getByText(/Installed from a different source/),
  ).toBeVisible();
  expect(within(group).getAllByRole("button")).toHaveLength(2);
  expect(git).not.toHaveBeenCalled();
});

it("reviews at the pinned commit, then installs and enables only after confirmation", async () => {
  const { manager, git, imports } = harness();
  show(manager, ready([entry("missing")]), [], { strict: true });
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Review plugin access",
  });
  await within(dialog).findByText(`Commit: ${commit}`);
  expect(git).toHaveBeenCalledExactlyOnceWith(
    "https://example.com/plugins",
    "v1",
    undefined,
    commit,
  );
  expect(within(dialog).getByText(/Recommended by Example Org/)).toBeVisible();
  expect(manager.installImport).not.toHaveBeenCalled();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Install plugin" }),
  );
  await waitFor(() =>
    expect(manager.installImport).toHaveBeenCalledExactlyOnceWith(
      "preview",
      "dist",
    ),
  );
  await waitFor(() =>
    expect(manager.change).toHaveBeenCalledExactlyOnceWith(
      "enable",
      "example.managed",
    ),
  );
  expect(imports.discard).toHaveBeenCalledWith("preview");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("keeps a new plugin disabled when the user opts out", async () => {
  const { manager } = harness();
  show(manager, ready([entry("missing")]));
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    await within(dialog).findByRole("switch", { name: "Enable plugin" }),
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Install plugin" }),
  );
  await waitFor(() => expect(manager.installImport).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(manager.change).not.toHaveBeenCalled();
});

it("discards the preview when the review is cancelled", async () => {
  const { manager, imports } = harness();
  show(manager, ready([entry("missing")]));
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "Cancel" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(imports.discard).toHaveBeenCalledWith("preview");
  expect(manager.installImport).not.toHaveBeenCalled();
});

it("offers an update for the installed plugin and preserves its enabled state", async () => {
  const { manager } = harness();
  show(manager, ready([entry("outdated")]), [{ ...installed, enabled: false }]);
  fireEvent.click(
    screen.getByRole("button", { name: "Review update example.managed" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Update Managed example",
  });
  expect(
    await within(dialog).findByText("This plugin will stay disabled."),
  ).toBeVisible();
  expect(
    within(dialog).queryByRole("switch", { name: "Enable plugin" }),
  ).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Update" }));
  await waitFor(() =>
    expect(manager.installImport).toHaveBeenCalledExactlyOnceWith(
      "preview",
      "dist",
    ),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(manager.change).not.toHaveBeenCalled();
});

it("refuses a moved reference and lets the user try again", async () => {
  const git = vi
    .fn()
    .mockRejectedValueOnce(
      "The repository reference is at commit abc, not the required commit def.",
    )
    .mockResolvedValue(preview());
  const { manager } = harness({ git });
  show(manager, ready([entry("missing")]));
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "not the required commit def",
  );
  expect(
    within(dialog).queryByRole("button", { name: "Install plugin" }),
  ).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
  expect(
    await within(dialog).findByRole("button", { name: "Install plugin" }),
  ).toBeEnabled();
  expect(git).toHaveBeenCalledTimes(2);
});

it("rejects a commit without the recommended plugin at the recommended path", async () => {
  const { manager, imports } = harness({
    git: vi.fn(async () =>
      preview({
        warnings: ["dist: No built plugin.js beside manifest.json"],
        candidates: [],
      }),
    ),
  });
  show(manager, ready([entry("missing")]));
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "dist: No built plugin.js beside manifest.json",
  );
  expect(imports.discard).toHaveBeenCalledWith("preview");
});

it("rejects a different plugin ID at the recommended path", async () => {
  const { manager } = harness({
    git: vi.fn(async () =>
      preview({
        candidates: [
          {
            path: "dist",
            revision: "new",
            manifest: { ...manifest, id: "example.other" },
          },
        ],
      }),
    ),
  });
  show(manager, ready([entry("missing")]));
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "example.other, not example.managed",
  );
});

it("keeps a failed installation open with its reason", async () => {
  const { manager } = harness();
  manager.installImport.mockResolvedValue(false);
  manager.snapshot = () => ({ error: "Registry is locked" });
  show(manager, ready([entry("missing")]));
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "Install plugin" }),
  );
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Registry is locked",
  );
  expect(manager.change).not.toHaveBeenCalled();
});

it("disables reviews while plugin management is busy", () => {
  const { manager } = harness();
  show(manager, ready([entry("missing")]), [], { busy: true });
  expect(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  ).toBeDisabled();
});

it("reports an unusable file and ignored entries without recommending anything", () => {
  const { manager } = harness();
  const invalid = show(manager, {
    status: "invalid",
    path: "/data/managed-plugins.json",
    reason: "Invalid JSON: EOF while parsing",
  });
  expect(screen.getByRole("status")).toHaveTextContent(
    "/data/managed-plugins.json. Invalid JSON: EOF while parsing",
  );
  expect(screen.queryByRole("button")).toBeNull();
  invalid.unmount();
  show(
    manager,
    ready(
      [],
      ["Plugin 2: commit must be a full 40 or 64 digit hexadecimal object ID"],
    ),
  );
  expect(
    screen.getByRole("heading", { name: "Recommended plugins" }),
  ).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Plugin 2: commit must be",
  );
  expect(screen.queryByRole("button")).toBeNull();
});

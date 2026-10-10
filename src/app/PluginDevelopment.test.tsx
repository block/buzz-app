// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PluginDevelopment } from "./PluginDevelopment";
import type { PluginManager } from "../plugins/manager";
import type { DevelopmentPreview, PluginInfo } from "../plugins/types";

afterEach(cleanup);
const plugin: PluginInfo = {
  manifest: { id: "buzz.inbox", name: "Inbox", apiVersion: 1 },
  enabled: true,
  source: "bundled",
  revision: "bundled",
  previous: null,
  reloadable: false,
  error: null,
  developmentSupported: true,
};
const preview: DevelopmentPreview = {
  token: "prepared",
  manifest: {
    ...plugin.manifest,
    host: {
      processes: [{ id: "worker", program: "worker", args: [] }],
      networkOrigins: ["https://example.com"],
    },
  },
  revision: "local",
  source: "/tmp/built-inbox",
};
function manager() {
  return {
    development: {
      folder: vi.fn(async () => preview),
      discard: vi.fn(async () => {}),
    },
    attachDevelopment: vi.fn(async () => true),
    restoreCompiled: vi.fn(async () => true),
  } as unknown as PluginManager & {
    development: NonNullable<PluginManager["development"]>;
  };
}
function mount(
  plugins: PluginManager = manager(),
  selected = plugin,
  busy = false,
) {
  return {
    plugins,
    ...render(
      <StrictMode>
        <PluginDevelopment plugins={plugins} plugin={selected} busy={busy} />
      </StrictMode>,
    ),
  };
}
it("previews declared access before attaching the original identity, and offers compiled recovery", async () => {
  const { plugins, rerender } = mount();
  fireEvent.click(screen.getByRole("button", { name: "Use local dev build" }));
  const section = await screen.findByRole("region", {
    name: "Local build preview for Inbox",
  });
  expect(plugins.development?.folder).toHaveBeenCalledWith("buzz.inbox");
  expect(plugins.attachDevelopment).not.toHaveBeenCalled();
  expect(section).toHaveTextContent("/tmp/built-inbox · buzz.inbox");
  expect(section).toHaveTextContent("Process worker");
  expect(section).toHaveTextContent(
    "HTTPS origin: https://example.com (new or changed)",
  );
  expect(section).toHaveTextContent("on and may run immediately");
  expect(section).toHaveTextContent("restores code, not data");
  fireEvent.click(screen.getByRole("button", { name: "Attach local build" }));
  await act(async () => {});
  expect(plugins.attachDevelopment).toHaveBeenCalledWith("prepared");
  expect(
    screen.queryByRole("region", { name: "Local build preview for Inbox" }),
  ).toBeNull();
  rerender(
    <PluginDevelopment
      plugins={plugins}
      plugin={{ ...plugin, source: "development" }}
      busy={false}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Local dev build · this launch only",
  );
  fireEvent.click(screen.getByRole("button", { name: "Use compiled" }));
  expect(plugins.restoreCompiled).toHaveBeenCalledWith("buzz.inbox");
});
it("retains a failed attach preview and discards it when explicitly closed", async () => {
  const plugins = manager();
  vi.mocked(plugins.attachDevelopment).mockResolvedValue(false);
  mount(plugins, { ...plugin, enabled: false });
  fireEvent.click(screen.getByRole("button", { name: "Use local dev build" }));
  expect(
    await screen.findByRole("region", {
      name: "Local build preview for Inbox",
    }),
  ).toHaveTextContent("It stays off");
  fireEvent.click(screen.getByRole("button", { name: "Attach local build" }));
  await act(async () => {});
  expect(
    screen.getByRole("region", { name: "Local build preview for Inbox" }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
  await act(async () => {});
  expect(plugins.development?.discard).toHaveBeenCalledWith("prepared");
  expect(
    screen.queryByRole("region", { name: "Local build preview for Inbox" }),
  ).toBeNull();
});
it("fences a late picker result after unmount and prevents overlapping picker requests", async () => {
  const plugins = manager();
  let resolve!: (next: DevelopmentPreview) => void;
  vi.mocked(plugins.development.folder).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const { unmount } = mount(plugins);
  const choose = screen.getByRole("button", { name: "Use local dev build" });
  fireEvent.click(choose);
  fireEvent.click(choose);
  expect(plugins.development?.folder).toHaveBeenCalledTimes(1);
  unmount();
  await act(async () => resolve(preview));
  expect(plugins.development?.discard).toHaveBeenCalledWith("prepared");
  expect(plugins.attachDevelopment).not.toHaveBeenCalled();
});
it("shows picker errors without discarding healthy compiled code", async () => {
  const plugins = manager();
  vi.mocked(plugins.development.folder).mockRejectedValue(
    new Error("Incompatible local build"),
  );
  mount(plugins);
  fireEvent.click(screen.getByRole("button", { name: "Use local dev build" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Incompatible local build",
  );
  expect(screen.getByRole("status")).toHaveTextContent("Compiled build");
  expect(plugins.attachDevelopment).not.toHaveBeenCalled();
});
it("discards a prepared preview on unmount", async () => {
  const { plugins, unmount } = mount();
  fireEvent.click(screen.getByRole("button", { name: "Use local dev build" }));
  await screen.findByRole("region", { name: "Local build preview for Inbox" });
  unmount();
  expect(plugins.development?.discard).toHaveBeenCalledWith("prepared");
});
it.each([false, undefined])(
  "hides unsupported controls (developmentSupported=%s)",
  (supported) => {
    mount(manager(), { ...plugin, developmentSupported: supported ?? false });
    expect(screen.queryByRole("button")).toBeNull();
  },
);
it("does not expose native controls in browser storage or while busy", () => {
  const plugins = manager();
  const { rerender } = mount({ ...plugins, development: undefined });
  expect(screen.queryByRole("button")).toBeNull();
  rerender(<PluginDevelopment plugins={plugins} plugin={plugin} busy />);
  expect(screen.getByRole("button")).toBeDisabled();
});

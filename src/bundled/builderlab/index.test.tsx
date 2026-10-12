// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HostService } from "../../features/host/service";
import { SettingsCardsService } from "../../features/settings/service";
import { Agents2Service } from "../../features/agents2/service";
import type { RelayData } from "../../features/relay/service";
import * as builderlab from "./index";
import { PluginRuntime } from "../../plugins/runtime";
import type { PluginInfo } from "../../plugins/types";
import manifest from "./manifest.json";
import { federatedFixture } from "../../features/federated-identity/testing";
import { enrollmentFixture } from "./agents/enrollment-testing";

const native = vi.hoisted(() => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);
beforeEach(() => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  vi.stubGlobal("navigator", {
    platform: "MacIntel",
    locks: {
      request: async (
        _name: string,
        _options: unknown,
        work: () => Promise<void>,
      ) => work(),
    },
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  native.invoke.mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function provideAgents2(root: Context, relay: RelayData) {
  return new Agents2Service(root, relay, {
    list: async () => [],
    create: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    forget: vi.fn(),
    publish: vi.fn(),
    publishProfile: vi.fn(),
    query: vi.fn(),
    upload: vi.fn(),
    remember: vi.fn(),
    claim: async () => true,
    release: vi.fn(),
  });
}

it("shares login across plugin disable/re-enable while API management remains unavailable", async () => {
  const root = new Context();
  const runtime = new PluginRuntime(root, async () => builderlab);
  new HostService(root);
  const fi = federatedFixture();
  Object.defineProperty(fi.service, "apiAvailable", { value: false });
  root.provide("federatedIdentity", fi.service);
  const cards = new SettingsCardsService(root);
  const community = enrollmentFixture(fi.session);
  root.provide("relay", community.relay);
  root.provide("communityReader", community.reader);
  const agents2 = provideAgents2(root, community.relay);
  const plugin: PluginInfo = {
    manifest: { ...manifest, apiVersion: 1 },
    source: "bundled",
    revision: "bundled",
    enabled: true,
    previous: null,
    reloadable: false,
    error: null,
  };
  try {
    runtime.reconcile([plugin]);
    await waitFor(() => expect(cards.snapshot()).toHaveLength(1));
    expect(agents2.types()).toMatchObject([
      { key: "block.builderlab/builderlab", title: "Builderlab" },
    ]);
    const card = cards.snapshot()[0];
    assert.exists(card);
    const Card = card.component;
    const mounted = render(<Card active={() => true} />);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByRole("button", { name: "Sign out" }),
    ).toBeEnabled();
    expect(
      screen.getByText(/Remote agent management is unavailable/),
    ).toBeInTheDocument();
    expect(fi.request).not.toHaveBeenCalled();
    await act(async () => runtime.reconcile([]));
    expect(cards.snapshot()).toHaveLength(0);
    expect(agents2.types()).toHaveLength(0);
    expect(fi.service.signOut).not.toHaveBeenCalled();
    mounted.unmount();
    runtime.reconcile([plugin]);
    await waitFor(() => expect(cards.snapshot()).toHaveLength(1));
    const fresh = cards.snapshot()[0];
    assert.exists(fresh);
    const Fresh = fresh.component;
    render(<Fresh active={() => true} />);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
    expect(native.invoke).not.toHaveBeenCalled();
  } finally {
    cleanup();
    await runtime.dispose();
    await root.fiber.dispose();
    await community.dispose();
  }
});

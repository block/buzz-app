// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createAgentClient,
  type RemoteAgentModelCatalog,
} from "../agents/client";
import type { Host } from "../../../features/host/service";
import { createTestSession, deferred } from "../test-helpers";
import { BuilderlabDefaults } from "./defaults";
import { createDefaultControl } from "./DefaultControl";

beforeEach(() =>
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example"),
);
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const catalog: RemoteAgentModelCatalog = {
  models: [
    {
      id: "one",
      displayName: "Sol 6.1",
      supportedReasoningEfforts: ["low", "high"],
    },
  ],
  recommended: { modelId: "one", reasoningEffort: "low" },
};
async function fixture() {
  const request = vi.fn<Host["request"]>(async () => ({
    status: 200,
    headers: {},
    body: JSON.stringify({
      models: [
        {
          id: "one",
          display_name: "Sol 6.1",
          supported_reasoning_efforts: ["low", "high"],
        },
      ],
      recommended_selection: { model_id: "one", reasoning_effort: "low" },
    }),
  }));
  const acquire = vi.fn(async () => ({
    revision: "first",
    account: {
      subject: "account",
      email: "agent@example.com",
      canUseRemoteAgents: true,
      canUseBuilderlabDecisions: false,
    },
  }));
  const session = createTestSession(acquire, undefined, {
    request: (input) => request(input),
  });
  await session.signIn();
  const defaults = new BuilderlabDefaults();
  const Control = createDefaultControl(
    createAgentClient(session, null),
    session,
    defaults,
  );
  render(<Control />);
  await screen.findByRole("button", {
    name: "Builderlab default model, Low thinking: Sol 6.1",
  });
  return { defaults, session, request, acquire };
}
async function chooseHigh() {
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: /^Builderlab default model/ }),
  );
  (await screen.findByRole("menuitem", { name: "OpenAI" })).focus();
  await user.keyboard("{ArrowRight}");
  (await screen.findByRole("menuitemradio", { name: "Sol 6.1" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(await screen.findByRole("menuitemradio", { name: "High" }));
}

it("saves an explicit thinking choice on the recommended model, restores it and resets", async () => {
  const h = await fixture();
  await chooseHigh();
  expect(
    await screen.findByRole("button", {
      name: "Builderlab default model, High thinking: Sol 6.1",
    }),
  ).toBeVisible();
  expect(new BuilderlabDefaults().resolve("account", catalog)).toEqual({
    modelId: "one",
    reasoningEffort: "high",
  });
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: /^Builderlab default model/ }));
  await userEvent.setup().click(
    await screen.findByRole("menuitem", {
      name: "Use Builderlab recommended",
    }),
  );
  expect(
    await screen.findByRole("button", { name: /Low thinking: Sol 6.1/ }),
  ).toBeVisible();
  expect(h.defaults.read("account")).toBeUndefined();
});

it("keeps the effective default when local persistence refuses a write", async () => {
  const h = await fixture();
  vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
    throw new Error("full");
  });
  await chooseHigh();
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not save");
  expect(h.defaults.read("account")).toBeUndefined();
  expect(
    screen.getByRole("button", { name: /Low thinking: Sol 6.1/ }),
  ).toBeVisible();
});

it("isolates persisted choices by account and environment and falls back for unsupported pairs", () => {
  const defaults = new BuilderlabDefaults();
  defaults.save("account", { modelId: "one", reasoningEffort: "high" });
  expect(defaults.resolve("other", catalog)).toEqual(catalog.recommended);
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://other.example");
  expect(defaults.resolve("account", catalog)).toEqual(catalog.recommended);
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  expect(new BuilderlabDefaults().resolve("account", catalog)).toEqual({
    modelId: "one",
    reasoningEffort: "high",
  });
  for (const saved of [
    { modelId: "gone", reasoningEffort: "high" },
    { modelId: "one", reasoningEffort: "gone" },
  ]) {
    defaults.save("account", saved);
    expect(defaults.resolve("account", catalog)).toEqual(catalog.recommended);
    expect(
      defaults.resolve("account", { models: catalog.models }),
    ).toBeUndefined();
  }
});

it("recovers a failed catalog request and ignores a late reply after account change", async () => {
  const h = await fixture();
  const pending = deferred<Awaited<ReturnType<Host["request"]>>>();
  h.request.mockImplementationOnce(() => pending.promise);
  act(() => h.session.signOut());
  await act(() => h.session.signIn());
  // Establish that the old account's catalog request started before switching.
  expect(h.request).toHaveBeenCalledTimes(2);
  act(() => h.session.signOut());
  h.acquire.mockResolvedValue({
    revision: "other",
    account: {
      subject: "other",
      email: "other@example.com",
      canUseRemoteAgents: true,
      canUseBuilderlabDecisions: false,
    },
  });
  h.request.mockResolvedValueOnce({ status: 400, headers: {}, body: "{}" });
  await act(() => h.session.signIn());
  expect(await screen.findByRole("alert")).toHaveTextContent("400");
  await act(async () =>
    pending.resolve({
      status: 200,
      headers: {},
      body: JSON.stringify({ models: [] }),
    }),
  );
  expect(screen.getByRole("alert")).toHaveTextContent("400");
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Retry models" }));
  expect(
    await screen.findByRole("button", { name: /Low thinking: Sol 6.1/ }),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

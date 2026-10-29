// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { RelayData } from "../../../features/relay/service";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { AgentSaveFooter } from "../../../features/agents/AgentSaveButton";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentTabs } from "../../agents/AgentTabs";
import type { Agents, Agent } from "../../../features/agents/service";
import type { Host, HostResponse } from "../../../features/host/service";
import { createAgentClient } from "../agents/client";
import { createOAuthSession } from "../oauth/session";
import { deferred } from "../test-helpers";
import { builderlabType } from "./index";

const first = "ab".repeat(32);
const second = "cd".repeat(32);
const agent = (pubkey = first): Agent => ({
  key: pubkey,
  pubkey,
  name: "Helper",
  type: "block.builderlab/builderlab",
  owner: "ef".repeat(32),
  relay: "wss://community.example",
  place: "hosted",
  config: {},
  attention: {},
  skipped: {},
  attentionEnabled: true,
  timers: {},
});
const response = (): HostResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify({
    status: 1,
    agents: [
      {
        agent_id: "one",
        agent_pubkey: first,
        agent_name: "Helper",
        status: 2,
        agent_instructions: "First instructions.",
      },
      {
        agent_id: "two",
        agent_pubkey: second,
        agent_name: "Other",
        status: 2,
        agent_instructions: "Second instructions.",
      },
    ],
  }),
});
beforeEach(() =>
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example"),
);
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});
function fixture() {
  let subject = "account-a";
  const session = createOAuthSession(async () => ({
    value: "credential",
    account: { subject, email: "a@example.com", canUseRemoteAgents: true },
  }));
  let stored = response();
  const request = vi.fn<Host["request"]>(async ({ url, body }) => {
    if (url.endsWith("/update-agent")) {
      const update = JSON.parse(body ?? "{}");
      const data = JSON.parse(stored.body);
      data.agents = data.agents.map((row: { agent_pubkey: string }) =>
        row.agent_pubkey === update.agent_pubkey
          ? {
              ...row,
              ...update,
              ...(update.model_id ? { model_selection_status: 1 } : {}),
            }
          : row,
      );
      stored = { ...stored, body: JSON.stringify(data) };
    }
    return url.endsWith("/get-model-catalog")
      ? {
          status: 200,
          headers: {},
          body: JSON.stringify({
            models: [
              {
                id: "one",
                display_name: "Friendly Model",
                supported_reasoning_efforts: ["high"],
              },
            ],
          }),
        }
      : stored;
  });
  const client = createAgentClient({ request, runCommand: vi.fn() }, session);
  const type = {
    ...builderlabType(client, session, {
      snapshot: () => ({ status: "disconnected", generation: 0 }),
      subscribe: () => () => {},
    } as unknown as RelayData),
    key: "block.builderlab/builderlab",
    pluginId: "block.builderlab",
    revision: "test",
  };
  const Tab = type.tabs?.[0]?.component;
  if (!Tab) throw new Error("Missing Builderlab settings");
  return {
    Tab,
    type,
    request,
    changeAccount: () => {
      subject = "account-b";
      session.signOut();
    },
  };
}
it("retries a failed load and refuses to save a draft through another account", async () => {
  const h = fixture();
  const user = userEvent.setup();
  h.request.mockResolvedValueOnce({ ...response(), status: 400 });
  render(<h.Tab agent={agent()} save={vi.fn()} />, { wrapper: StrictMode });
  expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 400");
  await user.click(screen.getByRole("button", { name: "Retry" }));
  const field = await screen.findByRole("textbox", { name: "Instructions" });
  expect(field).toHaveValue("First instructions.");
  await user.type(field, "Changed.");
  await act(async () => h.changeAccount());
  const before = h.request.mock.calls.length;
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "account that loaded these settings",
  );
  expect(h.request).toHaveBeenCalledTimes(before);
  expect(field).toHaveValue("First instructions.Changed.");
});
it("switching agents hides the old draft and ignores the switched-away read", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const mounted = render(<h.Tab agent={agent()} save={vi.fn()} />, {
    wrapper: StrictMode,
  });
  const field = await screen.findByRole("textbox", { name: "Instructions" });
  await user.type(field, "Unsaved.");
  const delayed = deferred<HostResponse>();
  h.request.mockReturnValueOnce(delayed.promise);
  try {
    mounted.rerender(<h.Tab agent={agent(second)} save={vi.fn()} />);
    await waitFor(() =>
      expect(
        h.request.mock.calls.filter(([request]) =>
          request.url.endsWith("/list-agents"),
        ),
      ).toHaveLength(2),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading instructions",
    );
    expect(
      screen.queryByRole("textbox", { name: "Instructions" }),
    ).not.toBeInTheDocument();
    mounted.rerender(<h.Tab agent={agent()} save={vi.fn()} />);
    expect(
      await screen.findByRole("textbox", { name: "Instructions" }),
    ).toHaveValue("First instructions.");
  } finally {
    await act(async () => {
      delayed.resolve(response());
      await delayed.promise;
    });
  }
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(
    "First instructions.",
  );
});

function renderTabs(h: ReturnType<typeof fixture>) {
  function Pane() {
    const [target, setTarget] = useState<HTMLDivElement | null>(null);
    return (
      <AgentSaveFooter value={{ target }}>
        <AgentTabs
          agents={{ save: vi.fn() } as unknown as Agents}
          agent={agent()}
          type={h.type}
          channels={[]}
          memories={undefined}
          settingsHost={{ typeControl: () => <p>Hosted provider</p> }}
          settingsContent={<p>Agent settings</p>}
        />
        <div ref={setTarget} data-testid="save-footer" />
      </AgentSaveFooter>
    );
  }
  render(<Pane />, { wrapper: StrictMode });
}

it("keeps hosted instructions on cancellation and resets a confirmed discard", async () => {
  const h = fixture();
  const user = userEvent.setup();
  renderTabs(h);
  expect(screen.queryByRole("tab", { name: "Instructions" })).toBeNull();
  expect(screen.getByRole("tab", { name: "Identity" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const field = await screen.findByRole("textbox", { name: "Instructions" });
  expect(await screen.findByRole("button", { name: /^Model:/ })).toBeVisible();
  expect(screen.getByRole("combobox", { name: "Thinking" })).toBeVisible();
  expect(screen.queryByText("Workspace")).toBeNull();
  expect(screen.getByRole("link", { name: "Builderlab" })).toHaveAttribute(
    "href",
    "https://builderlab.example",
  );
  await user.type(field, " Unsaved.");
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  expect(await screen.findByRole("alertdialog")).toHaveTextContent(
    "Discard changes?",
  );
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(field).toHaveValue("First instructions. Unsaved.");
  const save = screen.getByRole("button", { name: "Save" });
  const pending = deferred<HostResponse>();
  h.request.mockReturnValueOnce(pending.promise);
  try {
    await user.click(save);
    expect(field).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    expect(screen.getByRole("textbox", { name: "Instructions" })).toBe(field);
  } finally {
    await act(async () => pending.reject(new Error("offline")));
  }
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not reach Builderlab",
  );
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(field).toHaveValue("First instructions. Unsaved.");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not reach Builderlab",
  );
  expect(save).toBeEnabled();
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  await user.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(screen.queryByRole("textbox", { name: "Instructions" })).toBeNull();
  expect(screen.getByText("Workspace")).toBeVisible();
  expect(screen.getByText("One session per thread")).toBeVisible();
  expect(screen.getByText("Agent settings")).toBeVisible();
  expect(screen.queryByRole("button", { name: /^Model:/ })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Thinking" })).toBeNull();
  await user.click(screen.getByRole("tab", { name: "Identity" }));
  const fresh = await screen.findByRole("textbox", { name: "Instructions" });
  expect(fresh).not.toBe(field);
  expect(fresh).toHaveValue("First instructions.");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("Workspace")).toBeNull();
  expect(await screen.findByRole("button", { name: /^Model:/ })).toBeVisible();
});

it("guards hosted model drafts and a pending model save", async () => {
  const h = fixture();
  const user = userEvent.setup();
  renderTabs(h);
  await screen.findByRole("textbox", { name: "Instructions" });
  const modelTrigger = await screen.findByRole("button", { name: /^Model:/ });
  await waitFor(() => expect(modelTrigger).toBeEnabled());
  await user.click(modelTrigger);
  (await screen.findByRole("menuitem", { name: "Other" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Friendly Model" }),
  );
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByRole("button", { name: /^Model:/ })).toHaveTextContent(
    "Friendly Model",
  );
  await user.click(screen.getByRole("combobox", { name: "Thinking" }));
  await user.click(await screen.findByRole("option", { name: "High" }));
  const pending = deferred<HostResponse>();
  h.request.mockReturnValueOnce(pending.promise);
  try {
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    expect(screen.getByRole("button", { name: /^Model:/ })).toBeVisible();
  } finally {
    await act(async () => pending.reject(new Error("offline")));
  }
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not reach Builderlab",
  );
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  await user.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(screen.getByText("Agent settings")).toBeVisible();
  expect(screen.queryByRole("button", { name: /^Model:/ })).toBeNull();
  await user.click(screen.getByRole("tab", { name: "Identity" }));
  expect(
    await screen.findByRole("textbox", { name: "Instructions" }),
  ).toHaveValue("First instructions.");
  expect(
    await screen.findByRole("button", { name: /^Model:/ }),
  ).toHaveTextContent("Choose a model");
  expect(screen.getByRole("combobox", { name: "Thinking" })).toHaveTextContent(
    "Choose thinking",
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

it("saves model and instructions together through one footer action", async () => {
  const h = fixture();
  const user = userEvent.setup();
  renderTabs(h);
  const field = await screen.findByRole("textbox", { name: "Instructions" });
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  const modelTrigger = await screen.findByRole("button", { name: /^Model:/ });
  await waitFor(() => expect(modelTrigger).toBeEnabled());
  await user.click(modelTrigger);
  (await screen.findByRole("menuitem", { name: "Other" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Friendly Model" }),
  );
  await user.type(field, " Updated.");
  // A partial model draft cannot be silently skipped by Save.
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  await user.click(screen.getByRole("combobox", { name: "Thinking" }));
  await user.click(await screen.findByRole("option", { name: "High" }));
  const save = screen.getByRole("button", { name: "Save" });
  expect(screen.getByTestId("save-footer")).toContainElement(save);
  expect(save).toHaveAttribute("form", field.closest("form")?.id);
  await user.click(save);
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull(),
  );
  const updates = h.request.mock.calls.filter(([request]) =>
    request.url.endsWith("/update-agent"),
  );
  expect(updates).toHaveLength(1);
  expect(JSON.parse(updates[0]?.[0].body ?? "{}")).toEqual({
    agent_pubkey: first,
    agent_instructions: "First instructions. Updated.",
    model_id: "one",
    reasoning_effort: "high",
  });
  expect(field).toHaveValue("First instructions. Updated.");
  expect(modelTrigger).toHaveTextContent("Friendly Model");
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  expect(screen.getByText("Agent settings")).toBeVisible();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("keeps runtime settings available without loading Builderlab configuration", () => {
  const h = fixture();
  render(
    <h.Tab
      agent={agent()}
      save={vi.fn()}
      settingsSection="runtime"
      settingsContent={<p>Agent settings</p>}
    />,
    { wrapper: StrictMode },
  );
  expect(screen.getByText("Workspace")).toBeVisible();
  expect(screen.getByText("One session per thread")).toBeVisible();
  expect(screen.getByText("Agent settings")).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Instructions" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Model:/ })).toBeNull();
  expect(h.request).not.toHaveBeenCalled();
});

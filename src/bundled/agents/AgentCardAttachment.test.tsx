// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { snapshotPng } from "../../features/agents/agent-share";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import type { Navigation } from "../../features/navigation/controller";
import type { Attachment } from "../../features/relay/contracts";
import type { RelayData } from "../../features/relay/service";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { AgentCardAttachment, isAgentCard } from "./AgentCardAttachment";
import { agentTarget } from "./routes";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const echo = {
  key: "test/echo",
  title: "Echo",
  importShared: (source: { model: string }) => ({ model: source.model }),
} as unknown as RegisteredAgentType;
const snapshot = { agents: [] };
const types = [echo];
const agents = {
  subscribe: () => () => {},
  snapshot: () => snapshot,
  types: () => types,
  port: vi.fn(async () => ({
    agent: { pubkey: "e".repeat(64), name: "Ada" } as Agent,
    notes: [],
  })),
} as unknown as Agents & { port: ReturnType<typeof vi.fn> };
const connection = { status: "ready", origin: "https://relay.example" };
const relay = {
  snapshot: () => connection,
  subscribe: () => () => {},
} as unknown as RelayData;
const card: Attachment = {
  url: "https://relay.example/media/ada.png",
  kind: "image",
  mime: "image/png",
  name: "Ada.agent.png",
};

/** Media that answers with `body`. jsdom's Blob doesn't survive Node's
 * Response, so answer with the blob itself. */
const serve = (body: Blob) => {
  const fetch = vi.fn(async () => ({ ok: true, blob: async () => body }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
};

const show = (attachment = card) =>
  render(
    <AgentCardAttachment
      attachment={attachment}
      source="buzz-media://ada.png"
      agents={agents}
      relay={relay}
      canOpen={() => false}
      open={() => false}
    />,
  );

it("claims only the agent cards Share sends", () => {
  expect(isAgentCard(card)).toBe(true);
  expect(isAgentCard({ ...card, name: "Ada.png" })).toBe(false);
  expect(isAgentCard({ ...card, kind: "file" })).toBe(false);
});

it("shows a sent agent as its card, and adds it from there", async () => {
  const user = userEvent.setup();
  const fetch = serve(
    snapshotPng({
      name: "Ada",
      instructions: "Review pull requests.",
      runtime: "echo",
      model: "echo-1",
    }),
  );
  show();
  const button = await screen.findByRole("button", {
    name: "Ada, shared agent",
  });
  await vi.waitFor(() => expect(button).toBeEnabled());
  expect(fetch).toHaveBeenCalledWith("buzz-media://ada.png", expect.anything());
  expect(within(button).getByText("echo-1")).toBeInTheDocument();
  await user.click(button);
  const dialog = screen.getByRole("dialog", { name: "Ada" });
  // What it will follow can be changed before it is added.
  const instructions = within(dialog).getByRole("textbox", {
    name: "Instructions",
  });
  await user.clear(instructions);
  await user.type(instructions, "Review small pull requests.");
  await user.click(within(dialog).getByRole("button", { name: "Import" }));
  await vi.waitFor(() =>
    expect(agents.port).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "shared",
        name: "Ada",
        instructions: "Review small pull requests.",
      }),
    ),
  );
});

it("shows the picture when the file holds no agent", async () => {
  serve(new Blob(["not a card"], { type: "image/png" }));
  show();
  expect(await screen.findByRole("img", { name: "Ada" })).toHaveAttribute(
    "src",
    "buzz-media://ada.png",
  );
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("names what it added, and opens it from there", async () => {
  const user = userEvent.setup();
  serve(
    snapshotPng({
      name: "Ada",
      instructions: "Review pull requests.",
      runtime: "echo",
      model: "echo-1",
    }),
  );
  const navigator = { open: vi.fn(async () => ({})) };
  render(
    <AgentCardAttachment
      attachment={card}
      source="buzz-media://ada.png"
      agents={agents}
      relay={relay}
      navigator={navigator as unknown as Navigation}
      canOpen={() => false}
      open={() => false}
    />,
    { wrapper: ToastProvider },
  );
  const button = await screen.findByRole("button", {
    name: "Ada, shared agent",
  });
  await vi.waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  await user.click(
    within(screen.getByRole("dialog", { name: "Ada" })).getByRole("button", {
      name: "Import",
    }),
  );
  expect(
    await screen.findByText("Added Ada to your agents."),
  ).toBeInTheDocument();
  // sonner's pointer capture is missing in jsdom.
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(navigator.open).toHaveBeenCalledExactlyOnceWith(
    agentTarget("e".repeat(64)),
  );
});

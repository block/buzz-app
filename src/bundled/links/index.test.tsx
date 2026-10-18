// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationService } from "../../features/conversation/service";
import { HostService } from "../../features/host/service";
import { SettingsCardsService } from "../../features/settings/service";
import { PluginRuntime } from "../../plugins/runtime";
import type { PluginInfo } from "../../plugins/types";
import * as links from "./index";
import manifest from "./manifest.json";

const native = vi.hoisted(() => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);

const docUrl =
  "https://docs.google.com/document/d/1-B9PqLiMyqTOHYhRPDe7G8VKb0PsuNZVjitRNLHTFp8/edit";
const plugin: PluginInfo = {
  manifest: { ...manifest, apiVersion: 1 },
  source: "bundled",
  revision: "bundled",
  enabled: true,
  previous: null,
  reloadable: false,
  error: null,
};

beforeEach(() => {
  vi.stubEnv(
    "VITE_BUZZ_GOOGLE_OAUTH_CLIENT_ID",
    "client.apps.googleusercontent.com",
  );
  native.invoke.mockImplementation(async (command: string, input) => {
    if (command === "oauth_callback_begin")
      return {
        id: "attempt",
        callbackUrl: `http://127.0.0.1:12345${input.callbackPath}`,
      };
    if (command === "oauth_callback_wait")
      return { parameters: [["code", "one-time"]] };
    if (command === "oauth_callback_cancel") return;
    if (command === "plugin_host_request") {
      const url: string = input.request.url;
      const body = url.startsWith("https://oauth2.googleapis.com/token")
        ? { access_token: "access-1", expires_in: 3600 }
        : url.includes("/about?")
          ? { user: { emailAddress: "a@block.xyz", permissionId: "123" } }
          : { name: "Buzzin" };
      return { status: 200, headers: {}, body: JSON.stringify(body) };
    }
    throw new Error(`Unexpected command ${command}`);
  });
});
afterEach(() => {
  cleanup();
  native.invoke.mockReset();
  vi.unstubAllEnvs();
});

async function harness(desktop: boolean) {
  const root = new Context();
  const runtime = new PluginRuntime(root, async () => links);
  const conversation = new ConversationService(root);
  const cards = desktop ? new SettingsCardsService(root) : undefined;
  if (desktop) new HostService(root);
  runtime.reconcile([plugin]);
  await waitFor(() => expect(conversation.links.snapshot()).toHaveLength(1));
  const renderer = conversation.links.snapshot()[0];
  if (!renderer) throw new Error("Missing link renderer");
  return {
    cards,
    Link: renderer.component,
    async dispose() {
      cleanup();
      await runtime.dispose();
      await root.fiber.dispose();
    },
  };
}

it("labels Google Drive links with the signed-in account's file names through the plugin host", async () => {
  const h = await harness(true);
  try {
    await waitFor(() => expect(h.cards?.snapshot()).toHaveLength(1));
    const card = h.cards?.snapshot()[0];
    expect(card).toMatchObject({ title: "Google", group: "Integrations" });
    const Card = card?.component;
    if (!Card) throw new Error("Missing Google card");
    const { Link } = h;
    render(
      <>
        <Card active={() => true} />
        <p data-testid="message">
          <Link url={docUrl} />
          <Link url="https://github.com/block/buzz-app" />
        </p>
      </>,
    );
    const message = screen.getByTestId("message");
    expect(message).toHaveTextContent("docs.google.com/document/d/");
    expect(message).toHaveTextContent("github.com/block/buzz-app");
    expect(native.invoke).not.toHaveBeenCalledWith(
      "plugin_host_request",
      expect.anything(),
    );

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Sign in with Google" }),
    );
    expect(
      await screen.findByRole("button", { name: "Sign out" }),
    ).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Signed in as a@block.xyz.",
    );
    await waitFor(() => expect(message).toHaveTextContent("Buzzin"));
    expect(message).not.toHaveTextContent("docs.google.com");
    expect(message).toHaveTextContent("github.com/block/buzz-app");
    const lookup = native.invoke.mock.calls.find(
      ([command, input]) =>
        command === "plugin_host_request" &&
        input.request.url.startsWith(
          "https://www.googleapis.com/drive/v3/files/",
        ),
    )?.[1];
    expect(lookup).toMatchObject({
      id: "buzz.links",
      revision: "bundled",
      request: {
        url: "https://www.googleapis.com/drive/v3/files/1-B9PqLiMyqTOHYhRPDe7G8VKb0PsuNZVjitRNLHTFp8?fields=name&supportsAllDrives=true",
        headers: { Authorization: "Bearer access-1" },
      },
    });

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() =>
      expect(message).toHaveTextContent("docs.google.com/document/d/"),
    );
    expect(message).not.toHaveTextContent("Buzzin");
  } finally {
    await h.dispose();
  }
});

it("an unconfigured desktop build shows setup guidance and keeps plain labels", async () => {
  vi.stubEnv("VITE_BUZZ_GOOGLE_OAUTH_CLIENT_ID", "");
  const h = await harness(true);
  try {
    await waitFor(() => expect(h.cards?.snapshot()).toHaveLength(1));
    const Card = h.cards?.snapshot()[0]?.component;
    if (!Card) throw new Error("Missing Google card");
    render(<Card active={() => true} />);
    expect(screen.getByRole("status")).toHaveTextContent("not configured");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  } finally {
    await h.dispose();
  }
});

it("hosts without the desktop transport or Settings render ordinary labels and no card", async () => {
  const h = await harness(false);
  try {
    const { Link } = h;
    const { container } = render(<Link url={docUrl} />);
    expect(container).toHaveTextContent("docs.google.com/document/d/");
    expect(native.invoke).not.toHaveBeenCalled();
  } finally {
    await h.dispose();
  }
});

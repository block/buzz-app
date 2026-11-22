// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import * as htmlPreviewFeature from "../../app/html-preview-feature";
import { PluginRuntime } from "../../plugins/runtime";
import type { PluginInfo } from "../../plugins/types";
import { FileAttachment } from "../messages/FileAttachment";
import { PanelWorkspace } from "../panels/PanelWorkspace";
import { PanelsService } from "../panels/service";
import { ConversationService } from "../conversation/service";
import { emptySync } from "../communities/known-communities";
import type { ClientSnapshot } from "../communities/service";
import type { BrowserViewProps } from "../browser/api";
import { HtmlPreviewPanel } from "./HtmlPreviewPanel";
import {
  htmlAttachmentTarget,
  isHtmlAttachment,
  joinedRelayOrigins,
  parseHtmlPreviewTarget,
} from "./target";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const community = "https://relay.example";
const hash = "a".repeat(64);
const proseUrl = `${community}/media/${hash}.html#overview`;
const nativeSource = `buzz-media://localhost/${encodeURIComponent(`${community}/media/${hash}`)}?channel=general`;

function clientSnapshot(
  memberships: ClientSnapshot["memberships"] = [
    { id: community, name: "Relay" },
  ],
): ClientSnapshot {
  return {
    status: "ready",
    relayAvailable: true,
    profile: { name: "Ada", picture: "" },
    memberships,
    selected: memberships[0]?.id ?? null,
    sync: emptySync(),
  };
}

it("matches only joined-community relay HTML links and native HTML attachment cards", () => {
  const origins = joinedRelayOrigins(clientSnapshot());
  expect(parseHtmlPreviewTarget(proseUrl, origins)).toEqual({
    source: `${community}/media/${hash}.html`,
    name: `${hash}.html`,
    label: `${hash.slice(0, 8)}….html`,
    fragment: "#overview",
  });

  // Unjoined third-party origins, non-HTML blobs, and query-bearing URLs stay untouched.
  for (const ignored of [
    `https://other.example/media/${hash}.html`,
    `${community}/media/${hash}.pdf`,
    `${community}/media/${hash}.html?download=1`,
    `http://relay.example/media/${hash}.html`,
    "buzz:html-preview?source=https%3A%2F%2Frelay.example%2Fmedia%2Fbad",
  ]) {
    expect(parseHtmlPreviewTarget(ignored, origins)).toBeUndefined();
  }

  const cardTarget = htmlAttachmentTarget(nativeSource, "visual-board.html");
  if (!cardTarget) throw new Error("Expected HTML attachment target");
  expect(parseHtmlPreviewTarget(cardTarget, origins)).toEqual({
    source: nativeSource,
    name: "visual-board.html",
    label: "visual-board.html",
    fragment: "",
  });

  // Leaving the community revokes preview matching for its attachment targets too.
  expect(
    parseHtmlPreviewTarget(cardTarget, joinedRelayOrigins(clientSnapshot([]))),
  ).toBeUndefined();

  expect(
    isHtmlAttachment({ url: proseUrl, kind: "file", mime: "text/html" }),
  ).toBe(true);
  expect(
    isHtmlAttachment({
      url: `${community}/media/${hash}`,
      kind: "file",
      name: "Report.HTML",
    }),
  ).toBe(true);
  expect(
    isHtmlAttachment({ url: proseUrl, kind: "file", mime: "application/pdf" }),
  ).toBe(false);
});

it("resolves a loopback preview URL with fragment preservation and retries after failure", async () => {
  const user = userEvent.setup();
  const seenProps: BrowserViewProps[] = [];
  const View = (props: BrowserViewProps) => {
    seenProps.push(props);
    return <div data-testid="browser-view">{props.url}</div>;
  };
  const preparePreview = vi
    .fn<(source: string, name: string) => Promise<string>>()
    .mockRejectedValueOnce(new Error("Relay authentication failed"))
    .mockResolvedValueOnce("http://127.0.0.1:51234/cap/board.html");
  const origins = () => joinedRelayOrigins(clientSnapshot());

  render(
    <PanelWorkspace
      items={[
        {
          id: "tab-1",
          label: "Initial",
          content: (
            <HtmlPreviewPanel
              target={proseUrl}
              origins={origins}
              View={View}
              preparePreview={preparePreview}
            />
          ),
        },
      ]}
      value="tab-1"
      select={() => {}}
    />,
  );

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Relay authentication failed",
  );
  await user.click(screen.getByRole("button", { name: "Try again" }));

  expect(await screen.findByTestId("browser-view")).toHaveTextContent(
    "http://127.0.0.1:51234/cap/board.html#overview",
  );
  expect(seenProps.at(-1)?.allowOpenExternal).toBe(true);
  expect(preparePreview).toHaveBeenCalledTimes(2);
});

it("opens the side panel from HTML attachment cards while keeping Download separate", async () => {
  const user = userEvent.setup();
  const ctx = new Context();
  const runtime = new PluginRuntime(ctx, async () => htmlPreviewFeature);
  const panels = new PanelsService(ctx);
  const conversation = new ConversationService(ctx);
  ctx.provide("browser", {
    available: true,
    View: ({ url }: BrowserViewProps) => <div>{url}</div>,
  });
  ctx.provide("communityReader", {
    snapshot: () => clientSnapshot(),
    subscribe: () => () => {},
    retained: () => undefined,
  });
  ctx.provide("relay", {
    snapshot: () => ({ status: "disconnected" as const, generation: 0 }),
    subscribe: () => () => {},
    retry() {},
    tryAgain() {},
    disconnect() {},
    clearCache: async () => {},
    selected: () => community,
  });

  const plugin: PluginInfo = {
    manifest: { id: "buzz.html-preview", name: "HTML preview", apiVersion: 1 },
    enabled: true,
    source: "bundled",
    revision: "one",
    previous: null,
    reloadable: false,
    error: null,
  };
  runtime.reconcile([plugin]);

  await waitFor(() =>
    expect(panels.resolve(proseUrl)?.id).toBe("html-preview"),
  );
  expect(
    panels.resolve(`https://other.example/media/${hash}.html`),
  ).toBeUndefined();

  const attachment = {
    url: `${community}/media/${hash}`,
    kind: "file" as const,
    mime: "text/html",
    name: "board.html",
    size: 2048,
  };
  const renderer = conversation.attachments
    .snapshot()
    .find((entry) => entry.matches(attachment));
  if (!renderer) throw new Error("Expected HTML attachment renderer");

  const opened: string[] = [];
  const Component = renderer.component;
  render(
    <Component
      attachment={attachment}
      source={nativeSource}
      placement="message"
      FileCard={FileAttachment}
      canOpen={(target) => !!panels.resolve(target)}
      open={(target) => {
        opened.push(target);
        return true;
      }}
    />,
  );

  expect(screen.getByText("HTML · 2 KB")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Download board.html" }),
  ).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Preview board.html" }));
  await waitFor(() => expect(opened).toHaveLength(1));
  const [firstOpened] = opened;
  if (!firstOpened) throw new Error("Expected opened target");
  expect(panels.resolve(firstOpened)?.id).toBe("html-preview");

  await ctx.fiber.dispose();
});

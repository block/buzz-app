// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationService } from "../../features/conversation/service";
import { MessageMarkdown } from "../../features/messages/MessageMarkdown";
import { createPluginManager } from "../../plugins/manager";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import example from "./example.json";
import * as agentUi from "./index";
import manifest from "./manifest.json";

const disposals: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  cleanup();
  for (const dispose of disposals.splice(0)) await dispose();
  localStorage.removeItem("buzzodz.plugins.v1");
  vi.restoreAllMocks();
});

function setup() {
  const ctx = new Context();
  const plugins = createPluginManager(ctx, {
    bundled: [{ manifest: { ...manifest, apiVersion: 1 }, module: agentUi }],
  });
  const service = new ConversationService(ctx);
  disposals.push(async () => {
    await plugins.dispose();
    await ctx.fiber.dispose();
  });
  const message = (payload: unknown = example, interactive = true) => (
    <MessageMarkdown
      row={{
        id: "message",
        channelId: "channel",
        authorId: "author",
        content: `Here is your draft.\n\n\`\`\`buzz-ui\n${JSON.stringify(payload)}\n\`\`\``,
        createdAt: 1,
        mentions: [],
        participants: [],
        attachments: [],
        reactions: [],
        replyCount: 0,
      }}
      interactive={interactive}
      extensions={service}
      media={() => undefined}
      onOpenLink={() => false}
    />
  );
  return { plugins, message };
}

it("renders a message card, copies live edits and resets on a message edit", async () => {
  const user = userEvent.setup();
  const clipboard = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockResolvedValue();
  const { message } = setup();
  const view = render(message(), { wrapper: ToastProvider });
  const subject = await screen.findByRole("textbox", { name: "Subject" });
  await user.clear(subject);
  await user.type(subject, "Edited subject");
  const body = screen.getByRole("textbox", { name: "Body" });
  await user.clear(body);
  await user.type(body, "Current body");
  await user.click(screen.getByRole("button", { name: "Copy draft" }));
  await screen.findByRole("button", { name: "Copied" });
  expect(clipboard).toHaveBeenCalledWith(
    "Subject: Edited subject\n\nBody: Current body",
  );
  await user.type(subject, " again");
  expect(screen.getByRole("button", { name: "Copy draft" })).toBeEnabled();
  view.rerender(
    message({
      ...example,
      state: { subject: "New subject", body: "New body" },
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Subject" })).toHaveValue(
      "New subject",
    ),
  );
  expect(screen.getByRole("textbox", { name: "Body" })).toHaveValue("New body");
});

it("reports clipboard failure and recovers after the held operation settles", async () => {
  const user = userEvent.setup();
  let rejectCopy: (reason: Error) => void = () => {};
  vi.spyOn(navigator.clipboard, "writeText").mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectCopy = reject;
      }),
  );
  const { message } = setup();
  render(message(), { wrapper: ToastProvider });
  await screen.findByRole("textbox", { name: "Subject" });
  await user.click(screen.getByRole("button", { name: "Copy draft" }));
  expect(screen.getByRole("button", { name: "Copy draft" })).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await act(async () => rejectCopy(new Error("Clipboard unavailable")));
  await screen.findByText("Could not copy the draft");
  expect(screen.getByRole("button", { name: "Copy draft" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
});

it("keeps invalid cards, non-interactive previews and disabled plugins readable", async () => {
  const { plugins, message } = setup();
  const view = render(message({ ...example, version: 2 }), {
    wrapper: ToastProvider,
  });
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(view.container).toHaveTextContent('"version":2');
  view.rerender(message(example, false));
  expect(view.container.querySelector("pre code")).toHaveClass(
    "language-buzz-ui",
  );
  expect(screen.queryByRole("textbox")).toBeNull();
  view.rerender(message());
  await screen.findByRole("textbox", { name: "Subject" });
  await act(() => plugins.change("disable", "buzz.agent-ui"));
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(view.container.querySelector("pre code")).toHaveClass(
    "language-buzz-ui",
  );
});

it("renders markup-looking text literally without images or executable elements", async () => {
  const { message } = setup();
  const text =
    '<script>alert("x")</script><img src="https://example.org/tracker">';
  render(
    message({
      ...example,
      elements: {
        ...example.elements,
        intro: { ...example.elements.intro, props: { text } },
      },
    }),
    { wrapper: ToastProvider },
  );
  expect(await screen.findByText(text)).toBeVisible();
  expect(document.querySelector("script")).toBeNull();
  expect(document.querySelector("img")).toBeNull();
});

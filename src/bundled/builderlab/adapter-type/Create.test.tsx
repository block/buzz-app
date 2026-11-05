// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Host } from "../../../features/host/service";
import { createAgentClient } from "../agents/client";
import { createOAuthSession } from "../oauth/session";
import type { Credential } from "../oauth/browser";
import { deferred } from "../test-helpers";
import {
  createCreationFields,
  createCreationModel,
  EMPTY_CREATION,
} from "./Create";

beforeEach(() =>
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example"),
);
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});
const catalog = [
  {
    id: "one",
    display_name: "Model One",
    supported_reasoning_efforts: ["low", "high", "xhigh"],
  },
  {
    id: "two",
    display_name: "Model Two",
    supported_reasoning_efforts: ["none"],
  },
];
async function fixture(
  signedIn = true,
  /** Renders Create agent's AI settings rows, or its rows-layout fields. */
  layout?: { rows: "automatic" | "manual" | "fields" },
) {
  const acquire = vi.fn(async () => ({
    value: "credential",
    account: {
      subject: "account",
      email: "a@example.com",
      canUseRemoteAgents: true,
      canUseBuilderlabDecisions: false,
    },
  }));
  const session = createOAuthSession(acquire, undefined, {
    request: (input) => request(input),
  });
  if (signedIn) await session.signIn();
  let fail = false;
  const pending = deferred<void>();
  const request = vi.fn<Host["request"]>(async () => {
    await pending.promise;
    if (fail) return { status: 400, headers: {}, body: "{}" };
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({ models: catalog }),
    };
  });
  const client = createAgentClient(session, null);
  const Fields = createCreationFields(client, session);
  const Rows = createCreationModel(client, session);
  let draft = { ...EMPTY_CREATION };
  function Form() {
    const [config, setConfig] = useState(draft);
    draft = config;
    return (
      <form onSubmit={(event) => event.preventDefault()}>
        {layout && layout.rows !== "fields" ? (
          <Rows
            layout="rows"
            automatic={layout.rows === "automatic"}
            config={config}
            onChange={setConfig}
            disabled={false}
          />
        ) : (
          <Fields
            {...(layout ? { layout: "rows" as const } : {})}
            config={config}
            onChange={setConfig}
            disabled={false}
          />
        )}
      </form>
    );
  }
  render(<Form />, { wrapper: StrictMode });
  return {
    session,
    acquire,
    request,
    pending,
    draft: () => draft,
    fail: (value: boolean) => {
      fail = value;
    },
  };
}
async function choose(label: string, value: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: value }));
}

it("loads the catalog and keeps instructions alongside explicit model and effort choices", async () => {
  const h = await fixture();
  expect(screen.getByRole("status")).toHaveTextContent("Loading models");
  await act(async () => h.pending.resolve());
  const model = await screen.findByRole("combobox", { name: "Model" });
  expect(model).toHaveTextContent("Choose a model");
  expect(screen.getByRole("combobox", { name: "Thinking" })).toBeDisabled();
  await userEvent
    .setup()
    .type(
      screen.getByRole("textbox", { name: "Instructions Optional" }),
      "Be precise.",
    );
  await choose("Model", "Model One");
  await choose("Thinking", "Extra high");
  expect(h.draft().reasoningEffort).toBe("xhigh");
  await choose("Model", "Model Two");
  expect(h.draft().reasoningEffort).toBe("");
  expect(
    screen.getByRole("textbox", { name: "Instructions Optional" }),
  ).toHaveValue("Be precise.");
  await choose("Thinking", "None");
  expect(h.draft()).toEqual({
    instructions: "Be precise.",
    modelId: "two",
    reasoningEffort: "none",
    subject: "account",
  });
  expect(
    h.request.mock.calls.every(([input]) =>
      input.url.endsWith("/get-model-catalog"),
    ),
  ).toBe(true);
});

it("retains instructions when catalog loading fails and is retried", async () => {
  const h = await fixture();
  h.fail(true);
  await userEvent
    .setup()
    .type(
      screen.getByRole("textbox", { name: "Instructions Optional" }),
      "Keep this.",
    );
  await act(async () => h.pending.resolve());
  const retry = await screen.findByRole("button", { name: "Retry models" });
  expect(screen.getByRole("alert")).toHaveTextContent("HTTP 400");
  h.fail(false);
  await userEvent.setup().click(retry);
  await screen.findByRole("combobox", { name: "Model" });
  expect(h.draft().instructions).toBe("Keep this.");
  expect(h.draft().modelId).toBe("");
});

it("waits for explicit sign-in before loading the creation catalog", async () => {
  const h = await fixture(false);
  expect(h.acquire).not.toHaveBeenCalled();
  expect(h.request).not.toHaveBeenCalled();
  await act(async () => h.pending.resolve());
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Sign in with Builderlab" }));
  await screen.findByRole("combobox", { name: "Model" });
  expect(h.acquire).toHaveBeenCalledTimes(1);
});

it("can cancel a pending shared sign-in even while the creation form is disabled", async () => {
  const login = deferred<Credential>();
  let aborted = false;
  const session = createOAuthSession(
    (signal) => {
      signal.addEventListener("abort", () => (aborted = true));
      return login.promise;
    },
    undefined,
    { request: (input) => request(input) },
  );
  const request = vi.fn<Host["request"]>();
  const client = createAgentClient(session, null);
  const Create = createCreationFields(client, session);
  render(
    <Create config={{ ...EMPTY_CREATION }} disabled onChange={() => {}} />,
    { wrapper: StrictMode },
  );
  expect(
    screen.queryByRole("button", { name: "Cancel sign-in" }),
  ).not.toBeInTheDocument();
  await act(async () => {
    void session.signIn();
  });
  expect(screen.getByRole("status")).toHaveTextContent(
    "Finish sign-in in your browser",
  );
  const cancel = screen.getByRole("button", { name: "Cancel sign-in" });
  expect(cancel).toBeEnabled();
  await userEvent.setup().click(cancel);
  expect(aborted).toBe(true);
  expect(session.snapshot().status).toBe("signed-out");
  expect(
    screen.queryByRole("button", { name: "Cancel sign-in" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Sign in to choose a model",
  );
  expect(request).not.toHaveBeenCalled();
});

it("sets and shows Builderlab's own default under Automatic", async () => {
  const h = await fixture(true, { rows: "automatic" });
  expect(screen.getByText("Loading Builderlab’s models…")).toBeInTheDocument();
  await act(async () => h.pending.resolve());
  // The first model, on its first level when it offers no Medium.
  expect(await screen.findByText("Model One · Low")).toBeInTheDocument();
  expect(screen.getByText("Builderlab picks")).toBeInTheDocument();
  expect(h.draft()).toEqual({
    ...EMPTY_CREATION,
    modelId: "one",
    reasoningEffort: "low",
    subject: "account",
  });
});

it("offers Builderlab's Model and Thinking rows under Manual", async () => {
  const h = await fixture(true, { rows: "manual" });
  await act(async () => h.pending.resolve());
  expect(await screen.findByRole("combobox", { name: "Model" })).toBeEnabled();
  expect(screen.getByRole("combobox", { name: "Thinking" })).toBeDisabled();
  await choose("Model", "Model One");
  await choose("Thinking", "Extra high");
  expect(h.draft()).toMatchObject({
    modelId: "one",
    reasoningEffort: "xhigh",
    subject: "account",
  });
  // The rows carry no instructions field; Create agent shows its own.
  expect(
    screen.queryByRole("textbox", { name: "Instructions Optional" }),
  ).not.toBeInTheDocument();
});

it("asks for sign-in before Automatic can show Builderlab's pick", async () => {
  const h = await fixture(false, { rows: "automatic" });
  expect(
    screen.getByText("Sign in to Builderlab to choose a model."),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  expect(h.request).not.toHaveBeenCalled();
  expect(h.draft()).toEqual(EMPTY_CREATION);
});

it("shows only instructions in the rows layout, under the AI settings rows", async () => {
  const h = await fixture(true, { rows: "fields" });
  expect(
    screen.getByRole("textbox", { name: "Instructions Optional" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("combobox", { name: "Model" }),
  ).not.toBeInTheDocument();
  expect(h.request).not.toHaveBeenCalled();
});

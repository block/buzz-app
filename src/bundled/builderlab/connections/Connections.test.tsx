// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { HostRequest, HostResponse } from "../../../features/host/service";
import { createTestSession } from "../test-helpers";
import { createConnectionsClient } from "./client";
import { Connections } from "./Connections";
import { createConnectionsStore } from "./store";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const listed = (extensions: unknown[]): HostResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify({ extensions }),
});

async function fixture() {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const request = vi.fn(
    async (_input: HostRequest): Promise<HostResponse> =>
      listed([
        { name: "slack", created: "1" },
        {
          name: "google-calendar",
          created: "1",
          expires_at_epoch_s: String((NOW + 3 * DAY) / 1000 + 1),
        },
        { name: "jira", created: "1", previously_connected: true },
      ]),
  );
  const session = createTestSession(
    async () => ({
      revision: "secret",
      account: {
        subject: "user",
        email: "a@example.com",
        canUseRemoteAgents: false,
        canUseBuilderlabDecisions: false,
        canUseHostedTranscription: false,
      },
    }),
    undefined,
    { request: (input) => request(input) },
  );
  await session.signIn();
  const store = createConnectionsStore(
    createConnectionsClient(session),
    session,
  );
  const openPage = vi.fn();
  const onOverview = vi.fn();
  render(
    <Connections
      store={store}
      session={session}
      active={() => true}
      openPage={openPage}
      onOverview={onOverview}
      now={() => NOW}
    />,
  );
  const list = await screen.findByRole("list", { name: "Your connections" });
  return { request, openPage, onOverview, list };
}

it("lists connections needing attention first and reconnects one in the browser", async () => {
  const { list, openPage } = await fixture();
  const [jira, calendar, slack] = within(list).getAllByRole(
    "listitem",
  ) as HTMLElement[];
  expect(within(jira as HTMLElement).getByText("Expired")).toBeInTheDocument();
  expect(
    within(calendar as HTMLElement).getByText("Expires in 3 days"),
  ).toBeInTheDocument();
  expect(
    within(slack as HTMLElement).getByText("Connected"),
  ).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(
    "2 connections need attention",
  );
  await userEvent.click(screen.getByRole("button", { name: "Reconnect Jira" }));
  expect(openPage).toHaveBeenCalledWith("jira");
  await userEvent.click(screen.getByRole("button", { name: /Add connection/ }));
  expect(openPage).toHaveBeenLastCalledWith();
});

it("summarizes the list for its Settings card", async () => {
  const { onOverview } = await fixture();
  expect(onOverview).toHaveBeenLastCalledWith({
    kind: "filled",
    items: [
      { key: "attention", label: "2 need attention" },
      { key: "connected", label: "1 connected" },
    ],
  });
});

it("disconnects after confirmation and re-reads the list", async () => {
  const { request } = await fixture();
  await userEvent.click(
    screen.getByRole("button", { name: "Disconnect Slack" }),
  );
  const dialog = await screen.findByRole("alertdialog");
  request.mockClear();
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Disconnect" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
  );
  expect(
    request.mock.calls.map(([input]) => input.url.split("/").at(-1)),
  ).toEqual(["delete-oauth-extension", "list-oauth-extensions"]);
});

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginInstaller } from "../../plugins/installer";
import { CommunityPluginsPage } from "./CommunityPluginsPage";
import { INSTALL_TYPE, recordId, VOTE_TYPE } from "./community-counts";
import { createRecorder, type Recorder } from "./recorder";
import { fakeCommunity, listing, rawIndex } from "./testing";

const recorders: Recorder[] = [];
afterEach(() => {
  cleanup();
  for (const recorder of recorders.splice(0)) recorder.stop();
  window.localStorage.clear();
});

const indexUrl =
  "https://raw.githubusercontent.com/block/buzz-plugins/index/index.json";
const popular = listing({
  key: "github.com/octo/popular",
  slug: "popular",
  id: "octo.popular",
  name: "Popular board",
  source: {
    repository: "https://github.com/octo/popular",
    ref: "main",
    commit: "b".repeat(40),
  },
});
const index = rawIndex([listing(), popular]);
const channel = "00000001-0000-4000-8000-000000000000";
const others = ["b", "c", "d"].map((c) => c.repeat(64));

async function seeded() {
  const community = fakeCommunity({
    channels: [{ id: channel, creator: "a".repeat(64), createdAt: 1 }],
  });
  const put = async (
    type: typeof INSTALL_TYPE | typeof VOTE_TYPE,
    pubkey: string,
    key: string,
  ) =>
    community.store.put({
      pubkey,
      kind: 45010,
      created_at: 1,
      content: JSON.stringify({ version: 1, on: true }),
      tags: [
        ["ar", "1"],
        ["d", await recordId(channel, type, pubkey, key)],
        ["h", channel],
        ["type", type],
        ["plugin", key],
        ["op", "create"],
      ],
    });
  for (const pubkey of others) await put(INSTALL_TYPE, pubkey, popular.id);
  await put(INSTALL_TYPE, others[0] as string, listing().id);
  await put(VOTE_TYPE, others[0] as string, listing().id);
  return community;
}

async function setup(
  installer?: PluginInstaller,
  community?: ReturnType<typeof fakeCommunity>,
  listingRepository: string | undefined = "block/buzz-plugins",
) {
  const relay = community ?? (await seeded());
  const request = vi.fn(async ({ url }: { url: string }) => {
    if (url === indexUrl)
      return { status: 200, headers: {}, body: JSON.stringify(index) };
    if (url.startsWith("https://api.github.com/"))
      return { status: 200, headers: {}, body: '{"private":false}' };
    return { status: 202, headers: {}, body: "{}" };
  });
  const openPluginSettings = vi.fn();
  const recorder = createRecorder({
    relay: relay.relay,
    delayMs: 0,
    inventory: {
      installed: () =>
        installer?.getInstallationStatus(listing().id) === "installed"
          ? [
              {
                id: listing().id,
                source: {
                  repository: listing().source.repository,
                  path: "",
                  commit: listing().source.commit,
                },
              },
            ]
          : [],
      subscribe: () => () => {},
    },
  });
  recorders.push(recorder);
  render(
    <CommunityPluginsPage
      indexUrl={indexUrl}
      listingRepository={listingRepository}
      host={{ request }}
      installer={installer}
      relay={relay.relay}
      recorder={recorder}
      openPluginSettings={openPluginSettings}
    />,
  );
  return { request, openPluginSettings, community: relay };
}

function fakeInstaller(
  result: Awaited<ReturnType<PluginInstaller["requestInstall"]>>,
) {
  let status: "installed" | "absent" = "absent";
  const listeners = new Set<() => void>();
  const installer: PluginInstaller = {
    requestInstall: vi.fn(async () => {
      if (result === "installed") {
        status = "installed";
        for (const listener of listeners) listener();
      }
      return result;
    }),
    getInstallationStatus: () => status,
    subscribeInstallationStatus: (_id, listener) => {
      const wrapped = () => listener(status);
      listeners.add(wrapped);
      return () => listeners.delete(wrapped);
    },
  };
  return installer;
}

it("explains a build without an index and makes no requests", async () => {
  const openPluginSettings = vi.fn();
  render(
    <CommunityPluginsPage
      indexUrl=""
      host={{ request: vi.fn() }}
      installer={undefined}
      openPluginSettings={openPluginSettings}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "No community index configured" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Refresh community plugins" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Add your plugin" })).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Open plugin settings" }),
  );
  expect(openPluginSettings).toHaveBeenCalled();
});

it("lists plugins by installs in this community, and filters to a search", async () => {
  await setup();
  expect(
    await screen.findByText("Installed by 3 people here"),
  ).toBeInTheDocument();
  const rows = screen.getAllByRole("button", { name: /^Open / });
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
    "Open Popular board",
    "Open Octo notes",
  ]);
  expect(screen.getByText("1 upvote")).toBeInTheDocument();
  await userEvent.type(
    screen.getByLabelText("Search community plugins"),
    "zzz",
  );
  expect(
    screen.getByRole("heading", { name: "No plugins match" }),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(2);
});

it("shows a retry beside a failed index read", async () => {
  const request = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify(index),
    });
  render(
    <CommunityPluginsPage
      indexUrl={indexUrl}
      host={{ request }}
      installer={undefined}
      openPluginSettings={vi.fn()}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Buzz couldn't reach the community index.",
  );
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findAllByRole("button", { name: /^Open / })).toHaveLength(
    2,
  );
});

it("installs the indexed commit, records it here, then allows an upvote", async () => {
  const installer = fakeInstaller("installed");
  const { request, community } = await setup(installer);
  await screen.findByText("Installed by 3 people here");
  await userEvent.click(
    screen.getByRole("button", { name: "Open Octo notes" }),
  );
  expect(screen.getByRole("button", { name: "Upvote" })).toBeDisabled();
  expect(screen.getByText("Install it to upvote it.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Add to Buzz" }));
  expect(installer.requestInstall).toHaveBeenCalledWith({
    repository: "https://github.com/octo/notes-plugin",
    reference: "main",
    commit: "a".repeat(40),
  });
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Octo notes is installed and turned on.",
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Upvote" })).toBeEnabled(),
  );
  expect(screen.getByText(/Installed by 2 people here/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Upvote" }));
  expect(
    await screen.findByRole("button", { name: "Upvoted" }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("2 upvotes")).toBeInTheDocument();
  expect(community.publish).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.every(([input]) => input.url === indexUrl)).toBe(
    true,
  );
});

it("withdraws the viewer's records and writes none while recording is off", async () => {
  const installer = fakeInstaller("installed");
  const community = await seeded();
  await setup(installer, community);
  await screen.findByText("Installed by 3 people here");
  await userEvent.click(
    screen.getByRole("button", { name: "Open Octo notes" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Add to Buzz" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Upvote" })).toBeEnabled(),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "All community plugins" }),
  );
  await userEvent.click(
    await screen.findByRole("switch", {
      name: "Record my plugins in this community",
    }),
  );
  await waitFor(() =>
    expect(screen.getByText("Installed by 1 person here")).toBeInTheDocument(),
  );
  const writes = community.publish.mock.calls.length;
  await userEvent.click(
    screen.getByRole("button", { name: "Open Octo notes" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Reinstall" }));
  await screen.findByRole("status");
  expect(screen.getByRole("button", { name: "Upvote" })).toBeDisabled();
  expect(community.publish).toHaveBeenCalledTimes(writes);
});

it("hides counts when the community can't keep them", async () => {
  const community = fakeCommunity();
  delete (community.session as unknown as { snapshotRead?: unknown })
    .snapshotRead;
  await setup(undefined, community);
  expect(
    await screen.findByText("This community can't keep plugin counts."),
  ).toBeInTheDocument();
  expect(community.create).not.toHaveBeenCalled();
  expect(screen.queryByText(/Installed by/)).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Open Octo notes" }),
  );
  expect(screen.queryByRole("button", { name: "Upvote" })).toBeNull();
});

it("offers a retry when the install review closes without installing", async () => {
  const installer = fakeInstaller("cancelled");
  await setup(installer);
  await userEvent.click(
    await screen.findByRole("button", { name: "Open Octo notes" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Add to Buzz" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The review closed before anything was installed.",
  );
  expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
});

function githubAnswers(name: string, id: string, displayName: string) {
  return async ({ url }: { url: string }) => {
    if (url === indexUrl)
      return { status: 200, headers: {}, body: JSON.stringify(index) };
    if (url === `https://api.github.com/repos/octo/${name}`)
      return {
        status: 200,
        headers: {},
        body: '{"private":false,"default_branch":"main"}',
      };
    if (url.endsWith("/manifest.json?ref=main"))
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          encoding: "base64",
          content: btoa(JSON.stringify({ id, name: displayName })),
        }),
      };
    if (url.endsWith("/plugin.js?ref=main"))
      return { status: 200, headers: {}, body: "" };
    return { status: 404, headers: {}, body: "" };
  };
}

it("checks a repository, then links to a sources.txt pull request and a filled-in issue", async () => {
  const { request } = await setup();
  request.mockImplementation(githubAnswers("fresh", "octo.fresh", "Fresh"));
  await userEvent.click(
    await screen.findByRole("button", { name: "Add your plugin" }),
  );
  const check = screen.getByRole("button", { name: "Check" });
  expect(check).toBeDisabled();
  await userEvent.type(screen.getByLabelText("Repository"), "octo");
  await userEvent.click(check);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Enter a GitHub repository",
  );
  await userEvent.clear(screen.getByLabelText("Repository"));
  await userEvent.type(screen.getByLabelText("Repository"), "octo/fresh");
  await userEvent.click(screen.getByRole("button", { name: "Check" }));
  expect(await screen.findByText(/It can be listed/)).toBeInTheDocument();
  expect(
    screen.getByText("https://github.com/octo/fresh main"),
  ).toBeInTheDocument();
  const pr = screen.getByRole("link", { name: "Open a pull request" });
  expect(pr).toHaveAttribute(
    "href",
    "https://github.com/block/buzz-plugins/edit/main/sources.txt",
  );
  expect(pr).toHaveAttribute("target", "_blank");
  const issue = new URL(
    screen
      .getByRole("link", { name: "Request in an issue" })
      .getAttribute("href") ?? "",
  );
  expect(issue.pathname).toBe("/block/buzz-plugins/issues/new");
  expect(issue.searchParams.get("source")).toBe(
    "https://github.com/octo/fresh main",
  );
  const urls = request.mock.calls.map(([input]) => new URL(input.url).origin);
  expect(new Set(urls)).toEqual(
    new Set(["https://raw.githubusercontent.com", "https://api.github.com"]),
  );
  expect(
    request.mock.calls.some(
      ([input]) => (input as { method?: string }).method === "POST",
    ),
  ).toBe(false);
});

it("opens a plugin that is already listed instead of offering to list it", async () => {
  const { request } = await setup();
  request.mockImplementation(
    githubAnswers("popular", "octo.popular", "Popular board"),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Add your plugin" }),
  );
  await userEvent.type(
    screen.getByLabelText("Repository"),
    "https://github.com/octo/popular",
  );
  await userEvent.click(screen.getByRole("button", { name: "Check" }));
  expect(
    await screen.findByText("Popular board is already listed."),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Open a pull request" }),
  ).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "View listing" }));
  expect(
    screen.getByRole("heading", { name: "Popular board" }),
  ).toBeInTheDocument();
});

it("hides Add your plugin when the index isn't published from a GitHub repository", async () => {
  await setup(undefined, undefined, "");
  expect(await screen.findAllByRole("button", { name: /^Open / })).toHaveLength(
    2,
  );
  expect(screen.queryByRole("button", { name: "Add your plugin" })).toBeNull();
});

it("shows why GitHub rejected a repository and offers no links", async () => {
  const { request } = await setup();
  await userEvent.click(
    await screen.findByRole("button", { name: "Add your plugin" }),
  );
  request.mockResolvedValue({
    status: 200,
    headers: {},
    body: '{"private":true}',
  });
  await userEvent.type(screen.getByLabelText("Repository"), "octo/secret");
  await userEvent.click(screen.getByRole("button", { name: "Check" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "octo/secret is private. Only public repositories can be listed.",
  );
  expect(
    screen.queryByRole("link", { name: "Open a pull request" }),
  ).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "All community plugins" }),
  );
  expect(await screen.findAllByRole("button", { name: /^Open / })).toHaveLength(
    2,
  );
});

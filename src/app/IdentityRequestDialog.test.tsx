// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import { IdentityRequestDialog } from "./IdentityRequestDialog";
import {
  createIdentityRequests,
  parseIdentityRequest,
} from "../features/identity/identity-requests";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
  Channel: class {},
}));

const viewer = "ab".repeat(32);
const agent = "cd".repeat(32);
const state = "A".repeat(43);
const tag = ["auth", viewer, "", "ef".repeat(64)];
const opened = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "plugin:opener|open_url")
    .map(([, args]) => new URL((args as { url: string }).url));

function request(pubkey = agent, requestState = state) {
  const parsed = parseIdentityRequest(
    `buzz://authorize-identity?${new URLSearchParams({ version: "1", pubkey, callback: "https://app.example.org/buzz/callback", state: requestState })}`,
  );
  if (!parsed) throw new Error("expected a request");
  return parsed;
}

function show(pubkey = agent) {
  const requests = createIdentityRequests();
  render(<IdentityRequestDialog requests={requests} />);
  act(() => requests.open(request(pubkey), viewer));
  return requests;
}

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubEnv("VITE_BUZZ_LIVE", "0");
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command) => {
      if (command === "identity_restore") return viewer;
      if (command === "identity_prepare_remote_agent_authorization") return tag;
      if (command === "plugin:opener|open_url") return undefined;
      throw new Error(`Unexpected command: ${command}`);
    });
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("names the site and key, signs only on approval, and returns the proof to the callback", async () => {
  const user = userEvent.setup();
  const requests = show();
  expect(
    screen.getByRole("alertdialog", { name: "Authorize app.example.org?" }),
  ).toBeInTheDocument();
  expect(screen.getByDisplayValue(npubEncode(agent))).toBeInTheDocument();
  expect(invoke).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Authorize this key" }));
  await waitFor(() => expect(requests.snapshot()).toBeNull());
  expect(invoke).toHaveBeenCalledWith(
    "identity_prepare_remote_agent_authorization",
    { owner: viewer, agentPubkey: agent },
  );
  const [answer] = opened();
  if (!answer) throw new Error("expected an answer");
  expect(answer.origin + answer.pathname).toBe(
    "https://app.example.org/buzz/callback",
  );
  const fragment = new URLSearchParams(answer.hash.slice(1));
  expect(fragment.get("state")).toBe(state);
  expect(JSON.parse(fragment.get("proof") ?? "")).toEqual(tag);
});

it("tells the site when the owner denies, without signing", async () => {
  const user = userEvent.setup();
  const requests = show();
  await user.click(screen.getByRole("button", { name: "Deny" }));
  expect(requests.snapshot()).toBeNull();
  await waitFor(() => expect(opened()).toHaveLength(1));
  expect(opened()[0]?.hash).toBe(`#state=${state}&error=access_denied`);
  expect(invoke).not.toHaveBeenCalledWith(
    "identity_prepare_remote_agent_authorization",
    expect.anything(),
  );
});

it("never authorizes the owner's own key", () => {
  show(viewer);
  expect(
    screen.getByRole("button", { name: "Authorize this key" }),
  ).toBeDisabled();
  expect(screen.getByText(/your own key/)).toBeInTheDocument();
});

it("cannot be denied while approving, and a newer request replaces it without an answer", async () => {
  const user = userEvent.setup();
  let finish: (value: string[]) => void = () => {};
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "identity_restore") return viewer;
    if (command === "identity_prepare_remote_agent_authorization")
      return new Promise((resolve) => {
        finish = resolve;
      });
    if (command === "plugin:opener|open_url") return undefined;
    throw new Error(`Unexpected command: ${command}`);
  });
  const requests = show();
  await user.click(screen.getByRole("button", { name: "Authorize this key" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "identity_prepare_remote_agent_authorization",
      expect.anything(),
    ),
  );
  // Even the same link opened again is a new decision.
  expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(requests.snapshot()).not.toBeNull();
  const newer = request();
  act(() => requests.open(newer, viewer));
  await act(async () => finish(tag));
  expect(requests.snapshot()?.request).toBe(newer);
  expect(opened()).toHaveLength(0);
  expect(
    screen.getByRole("button", { name: "Authorize this key" }),
  ).toBeEnabled();
});

it("can try again after a failure", async () => {
  const user = userEvent.setup();
  let failures = 1;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "identity_restore") return viewer;
    if (command === "identity_prepare_remote_agent_authorization") {
      if (failures-- > 0) throw "Keychain is locked";
      return tag;
    }
    if (command === "plugin:opener|open_url") return undefined;
    throw new Error(`Unexpected command: ${command}`);
  });
  const requests = show();
  await user.click(screen.getByRole("button", { name: "Authorize this key" }));
  expect(await screen.findByText("Keychain is locked")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Authorize this key" }));
  await waitFor(() => expect(requests.snapshot()).toBeNull());
  expect(opened()).toHaveLength(1);
});

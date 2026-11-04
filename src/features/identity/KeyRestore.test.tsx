// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Recovery } from "./builderlab-account";
import { KeyRestore } from "./KeyRestore";
import type { RecoveryState } from "./service";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));
afterEach(cleanup);

const linked = "a".repeat(64);
const other = "b".repeat(64);
/** The signed-in first-run account. */
const subject = "account-a";
function recovery(state: RecoveryState, canceled = true) {
  return {
    subscribe: () => () => {},
    snapshot: () => state,
    beginRecovery: vi.fn(async () => {}),
    installRecovery: vi.fn(async () => {}),
    cancelRecovery: vi.fn(async () => canceled),
  } satisfies Recovery;
}
function mount(state: RecoveryState, canceled?: boolean) {
  const stub = recovery(state, canceled);
  render(
    <KeyRestore
      recovery={stub}
      expectedPubkey={linked}
      subject={subject}
      onBack={() => {}}
      onImport={() => {}}
      onInstalled={() => {}}
    />,
  );
  return stub;
}
const unmatched = (failedCount: number): RecoveryState => ({
  status: "choosing",
  candidates: [{ handle: "h1", pubkey: other }],
  currentPubkey: null,
  failedCount,
});

it("when every backup came back and none holds the linked key, offers only Enter my private key", () => {
  mount(unmatched(0));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "We found backups, but none contains the key linked to your account. Enter your private key to continue.",
  );
  expect(
    screen.getByRole("button", { name: "Enter my private key" }),
  ).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(
    screen.queryByText("Your key is stored securely on this device."),
  ).toBeNull();
});

it("when a backup failed to come back, does not claim none holds the key and retries over the live attempt", async () => {
  const stub = mount(unmatched(1));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "We couldn’t check all your backups. Try again, or enter your private key if you have a copy.",
  );
  expect(
    screen.getByRole("button", { name: "Enter my private key" }),
  ).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  // The service refuses a new attempt over one that recovered something:
  // the retry cancels first, then begins.
  await waitFor(() => expect(stub.beginRecovery).toHaveBeenCalledTimes(1));
  expect(stub.cancelRecovery).toHaveBeenCalledTimes(1);
  expect(stub.cancelRecovery.mock.invocationCallOrder).toEqual([
    expect.any(Number),
  ]);
  const [cancelOrder] = stub.cancelRecovery.mock.invocationCallOrder;
  const [beginOrder] = stub.beginRecovery.mock.invocationCallOrder;
  expect(cancelOrder).toBeLessThan(beginOrder ?? -1);
});

it("starts no new attempt when the live one could not be canceled", async () => {
  const stub = mount(unmatched(1), false);
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(stub.cancelRecovery).toHaveBeenCalledTimes(1));
  expect(stub.beginRecovery).not.toHaveBeenCalled();
});

it("with several backups of this account, preselects the linked identity and installs the one picked", async () => {
  const onInstalled = vi.fn();
  const stub = recovery({
    status: "choosing",
    candidates: [
      { handle: "other", pubkey: other },
      { handle: "linked", pubkey: linked },
    ],
    currentPubkey: linked,
    failedCount: 0,
    subject,
  });
  render(
    <KeyRestore
      recovery={stub}
      expectedPubkey={linked}
      subject={subject}
      onBack={() => {}}
      onImport={() => {}}
      onInstalled={onInstalled}
    />,
  );
  // Nothing installs until the user confirms a choice.
  expect(stub.installRecovery).not.toHaveBeenCalled();
  const radios = screen.getAllByRole("radio");
  expect(radios).toHaveLength(2);
  expect(
    screen.getByRole("radio", { checked: true }),
  ).toHaveAccessibleDescription(expect.stringContaining("Linked identity"));
  await userEvent.click(screen.getByRole("radio", { checked: false }));
  await userEvent.click(
    screen.getByRole("button", { name: "Restore this identity" }),
  );
  expect(stub.installRecovery).toHaveBeenCalledExactlyOnceWith("other");
  await waitFor(() => expect(onInstalled).toHaveBeenCalledTimes(1));
});

it("a partial recovery still offers its surviving other key, with Try again and Enter my private key beside the choice", async () => {
  const stub = mount({
    status: "choosing",
    candidates: [{ handle: "b", pubkey: other }],
    currentPubkey: linked,
    failedCount: 1,
    subject,
  });
  // The linked key's backup may be the one that failed: nothing is preselected.
  expect(screen.queryByRole("radio", { checked: true })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Restore this identity" }),
  ).toBeDisabled();
  expect(screen.getByText(/Some backups couldn’t be recovered/)).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Enter my private key" }),
  ).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(stub.beginRecovery).toHaveBeenCalledTimes(1));
  expect(stub.installRecovery).not.toHaveBeenCalled();
});

it.each([
  ["another account", "account-b"],
  ["an unknown account", undefined],
])(
  "backups recovered from %s offer only the linked key and never another",
  async (_label, recovered) => {
    const choosing = (candidates: { handle: string; pubkey: string }[]) =>
      ({
        status: "choosing",
        candidates,
        currentPubkey: other,
        failedCount: 0,
        subject: recovered,
      }) satisfies RecoveryState;
    const stub = mount(
      choosing([
        { handle: "other", pubkey: other },
        { handle: "linked", pubkey: linked },
      ]),
    );
    await waitFor(() =>
      expect(stub.installRecovery).toHaveBeenCalledExactlyOnceWith("linked"),
    );
    expect(screen.queryByRole("radiogroup")).toBeNull();
    cleanup();
    const none = mount(choosing([{ handle: "other", pubkey: other }]));
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "none contains the key linked to your account",
    );
    expect(none.installRecovery).not.toHaveBeenCalled();
  },
);

it("retries installation when a new attempt returns the same handle", async () => {
  const candidate: RecoveryState = {
    status: "choosing",
    candidates: [{ handle: "same", pubkey: linked }],
    currentPubkey: null,
    failedCount: 0,
  };
  let state: RecoveryState = candidate;
  const listeners = new Set<() => void>();
  const update = (next: RecoveryState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const stub: Recovery = {
    snapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    installRecovery: vi.fn(async () => {
      update({ status: "error", error: "Could not save key" });
    }),
    cancelRecovery: vi.fn(async () => true),
    beginRecovery: vi.fn(async () => {
      update(candidate);
    }),
  };
  render(
    <KeyRestore
      recovery={stub}
      expectedPubkey={linked}
      onBack={() => {}}
      onImport={() => {}}
      onInstalled={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: "Couldn’t restore your key" });
  expect(stub.installRecovery).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(stub.installRecovery).toHaveBeenCalledTimes(2));
  expect(stub.cancelRecovery).toHaveBeenCalledTimes(1);
});

it("preselects the key Settings chose to switch to over the linked one", () => {
  render(
    <KeyRestore
      recovery={recovery({
        status: "choosing",
        candidates: [
          { handle: "linked", pubkey: linked },
          { handle: "other", pubkey: other },
        ],
        currentPubkey: linked,
        failedCount: 0,
        subject,
      })}
      expectedPubkey={linked}
      subject={subject}
      preferredPubkey={other}
      onBack={() => {}}
      onImport={() => {}}
      onInstalled={() => {}}
    />,
  );
  expect(
    screen.getByRole("radio", { checked: true }),
  ).toHaveAccessibleDescription(expect.stringContaining("Other identity"));
});

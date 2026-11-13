// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  type UnheardAgent,
  type UnheardChoice,
  type UnheardOffer,
  useGuestAgentMentions,
} from "./useGuestAgentMentions";

afterEach(cleanup);

const pollen: UnheardAgent = {
  pubkey: "a".repeat(64),
  name: "Pollen",
  reason: "viewing-only",
  own: true,
};

/** Opens the dialog for `offer` and returns the send's eventual choice. */
function open(offer: Partial<UnheardOffer>) {
  let hook: ReturnType<typeof useGuestAgentMentions> | undefined;
  function Composer() {
    hook = useGuestAgentMentions(() => {});
    return hook.dialog;
  }
  render(<Composer />);
  let choice: Promise<UnheardChoice> | undefined;
  act(() => {
    choice = hook?.prepare(
      {
        agents: [pollen],
        channel: "foo-3",
        solo: true,
        current: () => true,
        ...offer,
      },
      new AbortController().signal,
    );
  });
  if (!choice) throw new Error("No dialog");
  return choice;
}

it("makes the agent a member, then sends", async () => {
  const steps: string[] = [];
  let confirm = () => {};
  const join = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        steps.push("change");
        confirm = () => {
          steps.push("confirmed");
          resolve();
        };
      }),
  );
  const choice = open({ join }).then((value) => {
    steps.push(`choice:${value}`);
    return value;
  });
  const dialog = await screen.findByRole("dialog", {
    name: "Pollen can’t reply here",
  });
  expect(dialog.textContent).toContain(
    "Pollen is viewing only in #foo-3. Make it a member so it can reply here, or ask it in a Solo chat.",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Make member and send" }),
  );
  // Nothing sends while the relay has yet to confirm the change.
  expect(screen.getByRole("button", { name: "Making member…" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(steps).toEqual(["change"]);
  act(() => confirm());
  await expect(choice).resolves.toBe("joined");
  expect(steps).toEqual(["change", "confirmed", "choice:joined"]);
  expect(join).toHaveBeenCalledTimes(1);
});

it("keeps the draft and shows why when the change fails", async () => {
  const join = vi.fn(async () => {
    throw new Error("restricted: only owners and admins can change roles");
  });
  let settled: UnheardChoice | "pending" = "pending";
  const choice = open({ join }).then((value) => {
    settled = value;
    return value;
  });
  await userEvent.click(
    await screen.findByRole("button", { name: "Make member and send" }),
  );
  expect((await screen.findByRole("alert")).textContent).toBe(
    "restricted: only owners and admins can change roles Your draft is kept.",
  );
  // Still open and unsent; the person decides what happens next.
  expect(settled).toBe("pending");
  expect(
    screen.getByRole("button", { name: "Make member and send" }),
  ).toHaveProperty("disabled", false);
  await userEvent.keyboard("{Escape}");
  await expect(choice).resolves.toBeNull();
});

it("doesn't send after the change when the draft changed meanwhile", async () => {
  let draft = true;
  const choice = open({
    join: async () => {
      draft = false;
    },
    current: () => draft,
  });
  await userEvent.click(
    await screen.findByRole("button", { name: "Make member and send" }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "The draft changed. Close this dialog and send again.",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Send here anyway" }),
  );
  await expect(choice).resolves.toBe("send");
});

it("offers only what the viewer can do when they can't change roles", async () => {
  const choice = open({});
  const dialog = await screen.findByRole("dialog", {
    name: "Pollen can’t reply here",
  });
  expect(screen.queryByRole("button", { name: /member/ })).toBeNull();
  expect(dialog.textContent).toContain(
    "Pollen is viewing only in #foo-3, so it answers you in your DM. Ask in a Solo chat",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Ask in a Solo chat" }),
  );
  await expect(choice).resolves.toBe("solo");
});

it("adds your agent from outside the channel in place of Invite", async () => {
  const join = vi.fn(async () => {});
  const choice = open({
    agents: [{ ...pollen, reason: "not-in-channel" }],
    join,
  });
  const dialog = await screen.findByRole("dialog", {
    name: "Pollen can’t reply here",
  });
  expect(dialog.textContent).toContain(
    "Pollen isn’t in #foo-3. Add it to the channel so it can reply here, or ask it in a Solo chat.",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Add to channel and send" }),
  );
  await expect(choice).resolves.toBe("joined");
});

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import type { ReactNode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  DEFAULT_DECISION_PROVIDER,
  DecisionsService,
  type DecisionProvider,
  type DecisionProviderStatus,
} from "../features/decisions/service";
import type { Membership } from "../features/communities/service";
import { DecisionsSettings } from "./DecisionsSettings";

afterEach(() => {
  cleanup();
  // The service saves choices in localStorage when given no storage.
  localStorage.clear();
});

const TYPESAFE = DEFAULT_DECISION_PROVIDER;
const BUILDERLAB = "block.builderlab/builderlab";
const BLOCK = "wss://block.example";
const FRIENDS = "wss://friends.example";
const memberships: Membership[] = [
  { id: BLOCK, name: "Block" },
  { id: FRIENDS, name: "Friends", localName: "Pals" },
];

/** The real service, with providers the test registers, changes and
 * removes. */
function setup() {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const decisions = new DecisionsService(root, undefined);
  const listeners = new Set<() => void>();
  const changed = () =>
    act(() => {
      for (const listener of [...listeners]) listener();
    });
  const removers = new Map<string, () => void>();
  /** Registers `plugin`'s provider `id`; `status` is read on every change. */
  const register = (
    key: string,
    status: (community?: string) => DecisionProviderStatus,
    extra: Partial<DecisionProvider> = {},
  ) => {
    const [plugin, id] = key.split("/") as [string, string];
    return root
      .extend({ pluginOwner: { id: plugin, revision: "one" } })
      .plugin((ctx) => {
        removers.set(
          key,
          ctx.decisions.registerProvider({
            id,
            label: id === "typesafe" ? "TypeSafe" : id,
            description: `About ${id}.`,
            status,
            subscribe: (listener) => {
              listeners.add(listener);
              return () => void listeners.delete(listener);
            },
            decide: async () => ({ outcome: "failed", reason: "unavailable" }),
            Settings: () => <p>Settings for {id}</p>,
            ...extra,
          }),
        );
      })
      .await();
  };
  const remove = (key: string) => act(() => removers.get(key)?.());
  return { root, decisions, register, changed, remove };
}

/** Builderlab as the community offers it: only in Block. */
const inBlock = (community?: string): DecisionProviderStatus =>
  community !== undefined && new URL(community).host === "block.example"
    ? "ready"
    : "needs-setup";

const row = (name: string) =>
  screen
    .getByText(name, { selector: ".buzz-preference-row-label" })
    .closest(".buzz-preference-row") as HTMLElement;

it("says to turn a provider on when none is, linking to Manage plugins", async () => {
  const user = userEvent.setup();
  const onSection = vi.fn();
  render(
    <DecisionsSettings
      decisions={setup().decisions}
      active={() => true}
      onSection={onSection}
    />,
  );
  expect(screen.getByRole("heading", { name: "Decisions API" })).toBeVisible();
  const status = screen.getByRole("status");
  expect(status).toHaveTextContent(
    "No decision provider is turned on. Turn one on in Manage plugins.",
  );
  await user.click(
    within(status).getByRole("button", { name: "Manage plugins" }),
  );
  expect(onSection).toHaveBeenCalledExactlyOnceWith("plugins");
});

it("shows every provider's settings once, with the communities where it answers", async () => {
  const { decisions, register, changed } = setup();
  let typesafe: DecisionProviderStatus = "ready";
  await register(TYPESAFE, () => typesafe);
  await register(BUILDERLAB, inBlock);
  render(
    <DecisionsSettings
      decisions={decisions}
      active={() => true}
      memberships={memberships}
    />,
  );
  expect(
    screen.getAllByText(/receives the message text sent with them/),
  ).toHaveLength(1);
  expect(row("builderlab")).toHaveTextContent("Available in Block");
  expect(row("TypeSafe")).toHaveTextContent(
    "Available in all your communities",
  );
  expect(screen.getByText("Settings for builderlab")).toBeVisible();
  expect(screen.getByText("Settings for typesafe")).toBeVisible();
  typesafe = "needs-setup";
  changed();
  expect(row("TypeSafe")).toHaveTextContent("Not set up");
  // Where TypeSafe answers no community, the community says what to do.
  expect(row("Pals")).toHaveTextContent(
    "Set up TypeSafe above to use decisions here",
  );
  expect(row("Block")).not.toHaveTextContent("Set up");
});

it("explains Builderlab access when no community offers it", async () => {
  const { decisions, register } = setup();
  await register(TYPESAFE, () => "ready");
  await register(BUILDERLAB, () => "needs-setup");
  render(
    <DecisionsSettings
      decisions={decisions}
      active={() => true}
      memberships={memberships}
    />,
  );
  expect(row("builderlab")).toHaveTextContent(
    "None of your communities offer Builderlab decisions to this account. For access, contact your account administrator.",
  );
});

it("says whether each provider is ready while there are no communities", async () => {
  const { decisions, register } = setup();
  await register(TYPESAFE, () => "needs-setup");
  await register("acme.helper/helper", () => "ready");
  render(<DecisionsSettings decisions={decisions} active={() => true} />);
  expect(row("TypeSafe")).toHaveTextContent("Not set up");
  expect(row("helper")).toHaveTextContent("Ready");
  expect(screen.queryByRole("combobox")).toBeNull();
});

it("chooses a provider for each community, offering only those that can answer there", async () => {
  const user = userEvent.setup();
  const { decisions, register } = setup();
  await register(TYPESAFE, () => "ready");
  await register(BUILDERLAB, inBlock);
  render(
    <DecisionsSettings
      decisions={decisions}
      active={() => true}
      memberships={memberships}
    />,
  );
  const menu = (name: string) =>
    screen.getByRole("combobox", { name: `Decision provider for ${name}` });
  // Until chosen, each answers with the first default that can.
  expect(menu("Block")).toHaveTextContent("builderlab");
  expect(menu("Pals")).toHaveTextContent("TypeSafe");
  await user.click(menu("Pals"));
  const offered = await screen.findByRole("option", { name: /builderlab/ });
  expect(offered).toHaveAttribute("aria-disabled", "true");
  expect(offered).toHaveTextContent("Not offered in this community");
  await user.keyboard("{Escape}");
  // Choosing in one community changes only that community.
  await user.click(menu("Block"));
  await user.click(await screen.findByRole("option", { name: /TypeSafe/ }));
  expect(decisions.backend(BLOCK)).toBe(TYPESAFE);
  expect(decisions.chosenIn(BLOCK)).toBe(TYPESAFE);
  expect(decisions.chosenIn(FRIENDS)).toBeUndefined();
  expect(menu("Block")).toHaveTextContent("TypeSafe");
});

it("changes nothing while hidden", async () => {
  const user = userEvent.setup();
  const { decisions, register } = setup();
  await register(TYPESAFE, () => "ready");
  await register(BUILDERLAB, inBlock);
  render(
    <DecisionsSettings
      decisions={decisions}
      active={() => false}
      memberships={memberships}
    />,
  );
  const menu = screen.getByRole("combobox", {
    name: "Decision provider for Block",
  });
  expect(menu).toHaveAttribute("data-disabled");
  await user.click(menu);
  expect(screen.queryByRole("option")).toBeNull();
  expect(decisions.chosenIn(BLOCK)).toBeUndefined();
});

it("keeps a provider's failing settings inside its own part, even while hidden", async () => {
  const user = userEvent.setup();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const { decisions, register } = setup();
  await register(TYPESAFE, () => "ready", {
    Settings: () => {
      throw new Error("broken plugin");
    },
  });
  await register("acme.helper/helper", () => "ready");
  let selected = "plugins";
  const onSection = vi.fn();
  // Settings mounts the Decisions section while another one is shown.
  const page = () => (
    <>
      <button type="button">Turn plugin off</button>
      <div hidden={selected !== "decisions"}>
        <DecisionsSettings
          decisions={decisions}
          active={() => selected === "decisions"}
          onSection={onSection}
          memberships={memberships}
        />
      </div>
    </>
  );
  const { rerender } = render(page());
  expect(screen.getByRole("button", { name: "Turn plugin off" })).toBeVisible();
  selected = "decisions";
  rerender(page());
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent(
    "TypeSafe settings are unavailable. You can turn its plugin off in Manage plugins.",
  );
  await user.click(
    within(alert).getByRole("button", { name: "Manage plugins" }),
  );
  expect(onSection).toHaveBeenCalledExactlyOnceWith("plugins");
  // The rest of the section still works.
  expect(screen.getByText("Settings for helper")).toBeVisible();
  await user.click(
    screen.getByRole("combobox", { name: "Decision provider for Block" }),
  );
  await user.click(await screen.findByRole("option", { name: /helper/ }));
  expect(decisions.backend(BLOCK)).toBe("acme.helper/helper");
  consoleError.mockRestore();
});

/** Builderlab's settings have a Sign out button that removes it, as a
 * sign-out does. */
async function withdrawable(typesafe = true) {
  const context = setup();
  if (typesafe) await context.register(TYPESAFE, () => "ready");
  await context.register(BUILDERLAB, inBlock, {
    Settings: () => (
      <button type="button" onClick={() => context.remove(BUILDERLAB)}>
        Sign out
      </button>
    ),
  });
  return context;
}

it("hands focus to the section when the focused provider's settings go", async () => {
  const user = userEvent.setup();
  const { decisions } = await withdrawable();
  render(
    <DecisionsSettings
      decisions={decisions}
      active={() => true}
      memberships={memberships}
    />,
  );
  screen.getByRole("button", { name: "Sign out" }).focus();
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  expect(screen.getByRole("region", { name: "Decisions API" })).toHaveFocus();
  // Block goes back to TypeSafe.
  expect(
    screen.getByRole("combobox", { name: "Decision provider for Block" }),
  ).toHaveTextContent("TypeSafe");
});

it("leaves focus elsewhere alone when a provider is removed, as by a 401", async () => {
  const { decisions, remove } = await withdrawable();
  render(
    <>
      <button type="button">Elsewhere</button>
      <DecisionsSettings decisions={decisions} active={() => true} />
    </>,
  );
  const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
  elsewhere.focus();
  remove(BUILDERLAB);
  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  expect(elsewhere).toHaveFocus();
});

it("hands focus to the section when the removed provider was the only one", async () => {
  const user = userEvent.setup();
  const { decisions } = await withdrawable(false);
  render(<DecisionsSettings decisions={decisions} active={() => true} />);
  screen.getByRole("button", { name: "Sign out" }).focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("status")).toHaveTextContent("Manage plugins");
  expect(screen.getByRole("region", { name: "Decisions API" })).toHaveFocus();
});

it("shows a provider removed from a community's menu as unavailable there", async () => {
  const { decisions, register, remove } = setup();
  await register(TYPESAFE, () => "ready");
  await register("acme.helper/helper", () => "ready");
  act(() => decisions.setBackend("acme.helper/helper", BLOCK));
  render(
    <DecisionsSettings
      decisions={decisions}
      active={() => true}
      memberships={memberships}
    />,
  );
  remove("acme.helper/helper");
  // A chosen provider that is not a default never moves to another.
  expect(row("Block")).toHaveTextContent("No provider can answer here");
  expect(decisions.backend(BLOCK)).toBeUndefined();
  expect(decisions.backend(FRIENDS)).toBe(TYPESAFE);
});

it("keeps rendering when the community list has one that is not a relay", async () => {
  const { decisions, register } = setup();
  await register(TYPESAFE, () => "ready");
  const nodes: ReactNode = (
    <DecisionsSettings
      decisions={decisions}
      active={() => true}
      memberships={[{ id: "not a relay", name: "Broken" }, ...memberships]}
    />
  );
  render(nodes);
  expect(screen.queryByText("Broken")).toBeNull();
  expect(row("Block")).toBeVisible();
});

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import type { ReactNode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  DECISIONS_OFF,
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
const DESIGN = "wss://design.block.example";
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
  offeredInBlock(community) ? "ready" : "needs-setup";
const offeredInBlock = (community?: string) =>
  community !== undefined && new URL(community).host === "block.example";

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

it("shows each community's provider setup", async () => {
  const { decisions, register, changed } = setup();
  let typesafe: DecisionProviderStatus = "ready";
  await register(TYPESAFE, () => typesafe);
  // One Builderlab account serves both Block communities; Friends has none.
  await register(BUILDERLAB, inBlock, {
    offered: (community) =>
      !!community && new URL(community).host.endsWith("block.example"),
    Settings: ({ community }) => (
      <p>Sign-in for {community && new URL(community).host}</p>
    ),
  });
  act(() => decisions.setBackend(BUILDERLAB, BLOCK));
  act(() => decisions.setBackend(BUILDERLAB, DESIGN));
  render(
    <DecisionsSettings
      decisions={decisions}
      active={() => true}
      memberships={[...memberships, { id: DESIGN, name: "Design" }]}
    />,
  );
  expect(
    screen.getAllByText(/receives the message text sent with them/),
  ).toHaveLength(1);
  // Each community sets up its own choice.
  expect(screen.getByText("Sign-in for block.example")).toBeVisible();
  expect(screen.getByText("Sign-in for design.block.example")).toBeVisible();
  expect(screen.queryByText(/Same .* as/)).toBeNull();
  expect(screen.getByText("Settings for typesafe")).toBeVisible();
  // Design's Builderlab cannot answer yet, and the row says so: TypeSafe
  // does not answer in its place.
  expect(decisions.backend(DESIGN)).toBe(BUILDERLAB);
  expect(row("Design")).toHaveTextContent(
    "Set up builderlab to use decisions here",
  );
  expect(row("Block")).not.toHaveTextContent("Set up");
  // A Builderlab chosen where it is not offered says that.
  act(() => decisions.setBackend(BUILDERLAB, FRIENDS));
  expect(row("Pals")).toHaveTextContent(
    "builderlab isn’t offered in this community",
  );
  // Its setup can't help there, so the row shows none.
  expect(screen.queryByText(/Sign-in for friends/)).toBeNull();
  expect(screen.getAllByText(/^Sign-in for /)).toHaveLength(2);
  act(() => decisions.setBackend(TYPESAFE, FRIENDS));
  typesafe = "needs-setup";
  changed();
  expect(row("Pals")).toHaveTextContent(
    "Set up TypeSafe to use decisions here",
  );
});

it("says whether each provider is ready while there are no communities", async () => {
  const { decisions, register } = setup();
  await register(TYPESAFE, () => "needs-setup");
  await register("acme.helper/helper", () => "ready");
  render(<DecisionsSettings decisions={decisions} active={() => true} />);
  expect(row("TypeSafe")).toHaveTextContent("Not set up");
  expect(row("helper")).toHaveTextContent("Ready");
  expect(screen.getByText("Settings for helper")).toBeVisible();
  expect(screen.queryByRole("combobox")).toBeNull();
});

it("keeps rendering when a provider's status or offered() throws", async () => {
  const user = userEvent.setup();
  const { decisions, register } = setup();
  await register(TYPESAFE, () => "ready");
  await register(
    "acme.helper/helper",
    () => {
      throw new Error("plugin bug");
    },
    {
      offered: () => {
        throw new Error("plugin bug");
      },
    },
  );
  const view = render(
    <DecisionsSettings decisions={decisions} active={() => true} />,
  );
  // Without communities: a status it cannot read is not yet confirmed.
  expect(row("helper")).toHaveTextContent("Ready");
  view.unmount();
  render(
    <DecisionsSettings
      decisions={decisions}
      active={() => true}
      memberships={memberships}
    />,
  );
  const menu = screen.getByRole("combobox", {
    name: "Decision provider for Block",
  });
  expect(menu).toHaveTextContent("TypeSafe");
  // A provider whose offered() throws is not offered.
  await user.click(menu);
  const helper = await screen.findByRole("option", { name: /helper/ });
  expect(helper).toHaveAttribute("aria-disabled", "true");
  expect(helper).toHaveTextContent("Not offered in this community");
});

it("chooses a provider for each community, offering only those it can be set up in", async () => {
  const user = userEvent.setup();
  const { decisions, register } = setup();
  await register(TYPESAFE, () => "ready");
  await register(BUILDERLAB, inBlock, {
    offered: offeredInBlock,
  });
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

it("turns decisions off in one community, with no setup shown there", async () => {
  const user = userEvent.setup();
  const { decisions, register } = setup();
  await register(TYPESAFE, () => "ready");
  await register(BUILDERLAB, inBlock, {
    offered: offeredInBlock,
    Settings: ({ community }) => (
      <p>Sign-in for {community && new URL(community).host}</p>
    ),
  });
  render(
    <DecisionsSettings
      decisions={decisions}
      active={() => true}
      memberships={memberships}
    />,
  );
  const menu = (name: string) =>
    screen.getByRole("combobox", { name: `Decision provider for ${name}` });
  expect(screen.getByText("Sign-in for block.example")).toBeVisible();
  await user.click(menu("Block"));
  await user.click(await screen.findByRole("option", { name: "Off" }));
  expect(decisions.chosenIn(BLOCK)).toBe(DECISIONS_OFF);
  expect(decisions.backend(BLOCK)).toBeUndefined();
  expect(menu("Block")).toHaveTextContent("Off");
  expect(row("Block")).toHaveTextContent("Decisions are off in this community");
  expect(screen.queryByText("Sign-in for block.example")).toBeNull();
  // Other communities are unchanged.
  expect(decisions.chosenIn(FRIENDS)).toBeUndefined();
  expect(menu("Pals")).toHaveTextContent("TypeSafe");
  // Choosing a provider turns them back on.
  await user.click(menu("Block"));
  await user.click(await screen.findByRole("option", { name: /builderlab/ }));
  expect(decisions.backend(BLOCK)).toBe(BUILDERLAB);
  expect(row("Block")).not.toHaveTextContent("off");
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
  // Each community using TypeSafe shows its failure.
  const alerts = screen.getAllByRole("alert");
  expect(alerts).toHaveLength(2);
  const [alert] = alerts as [HTMLElement];
  expect(alert).toHaveTextContent(
    "TypeSafe settings are unavailable. You can turn its plugin off in Manage plugins.",
  );
  await user.click(
    within(alert).getByRole("button", { name: "Manage plugins" }),
  );
  expect(onSection).toHaveBeenCalledExactlyOnceWith("plugins");
  // The rest of the section still works.
  await user.click(
    screen.getByRole("combobox", { name: "Decision provider for Block" }),
  );
  await user.click(await screen.findByRole("option", { name: /helper/ }));
  expect(decisions.backend(BLOCK)).toBe("acme.helper/helper");
  expect(screen.getByText("Settings for helper")).toBeVisible();
  consoleError.mockRestore();
});

/** Builderlab's settings have a Sign out button that removes it, as a
 * sign-out does. */
async function withdrawable(typesafe = true) {
  const context = setup();
  if (typesafe) await context.register(TYPESAFE, () => "ready");
  await context.register(BUILDERLAB, inBlock, {
    offered: offeredInBlock,
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

it("shows decisions off where the chosen provider's plugin is off, until it returns", async () => {
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
  const menu = () =>
    screen.getByRole("combobox", { name: "Decision provider for Block" });
  remove("acme.helper/helper");
  // A chosen provider never moves to another: decisions are off there.
  expect(row("Block")).toHaveTextContent("Decisions are off in this community");
  expect(menu()).toHaveTextContent("Off");
  expect(decisions.backend(BLOCK)).toBeUndefined();
  expect(decisions.backend(FRIENDS)).toBe(TYPESAFE);
  // The choice is kept, so it returns with its plugin.
  expect(decisions.chosenIn(BLOCK)).toBe("acme.helper/helper");
  await act(() => register("acme.helper/helper", () => "ready"));
  expect(menu()).toHaveTextContent("helper");
  expect(row("Block")).not.toHaveTextContent("off");
});

it("saves Off in a community while no provider is turned on", async () => {
  const user = userEvent.setup();
  const { decisions, register, remove } = setup();
  await register(TYPESAFE, () => "ready");
  act(() => decisions.setBackend(TYPESAFE, BLOCK));
  render(
    <DecisionsSettings
      decisions={decisions}
      active={() => true}
      memberships={memberships}
    />,
  );
  remove(TYPESAFE);
  // The notice, and each community's row, still with Off.
  expect(screen.getByText(/No decision provider is turned on/)).toBeVisible();
  const menu = () =>
    screen.getByRole("combobox", { name: "Decision provider for Block" });
  expect(menu()).toHaveTextContent("Off");
  await user.click(menu());
  await user.click(await screen.findByRole("option", { name: "Off" }));
  expect(decisions.chosenIn(BLOCK)).toBe(DECISIONS_OFF);
  // It stays off when TypeSafe returns; Pals made no choice and uses it.
  await act(() => register(TYPESAFE, () => "ready"));
  expect(menu()).toHaveTextContent("Off");
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

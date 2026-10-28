// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode, useSyncExternalStore } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LinkLabel } from "../../bundled/links/InlineLink";
import { LockIcon } from "../../shared/design-system/icons";
import referenceStyles from "../../shared/InlineReference.module.css";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
import { profileTarget } from "../profiles/target";
import {
  createChannelPresentation,
  type ChannelPresentation,
} from "./channel-presentation";
import {
  ChannelPresentationContext,
  ChannelRowPresentationContext,
  useChannelRow,
} from "./channel-presentation-react";
import { MessageRow } from "./MessageRow";
import { row, fixture } from "./channel-presentation.testing";
import { createRelaySession } from "../relay/session";
import type { ChannelMessage } from "../relay/contracts";

stubAvatarBrowserApis();
const serviceOwners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of serviceOwners.splice(0)) owner.dispose();
});
function mountedFixture(rows: readonly ChannelMessage[]) {
  const controlled = fixture(rows),
    base = createRelaySession(null);
  serviceOwners.push(base);
  return {
    ...controlled,
    session: {
      ...base.session,
      ...controlled.session,
      profiles: { ...base.session.profiles, ...controlled.session.profiles },
    },
  };
}
const emptyEntries: readonly never[] = [];
const emptyRegistry = {
  snapshot: () => emptyEntries,
  subscribe: () => () => {},
};
const links = [
  {
    id: "link",
    title: "Links",
    key: "links/link",
    pluginId: "links",
    revision: "one",
    matches: () => true,
    component: ({ url }: { url: string }) => <LinkLabel href={url} />,
  },
];
const extensions = {
  inline: emptyRegistry,
  tools: emptyRegistry,
  messages: emptyRegistry,
  links: { snapshot: () => links, subscribe: () => () => {} },
};

// Real React external-store lifecycle and real MessageRow/Markdown consumers.
// Source services are controlled immutable snapshots, not substitute hooks.
function PresentedRow({
  owner,
  id,
}: {
  owner: ChannelPresentation;
  id: string;
}) {
  const facts = useChannelRow(owner, id);
  return facts ? (
    <ChannelRowPresentationContext.Provider value={facts}>
      <MessageRow
        extensions={extensions}
        row={facts.row}
        session={owner.session}
        scope="projected-contract"
        profile={facts.profiles.get(facts.row.authorId)}
        participantProfiles={facts.profiles}
        agentPubkeys={facts.agentPubkeys}
        media={() => undefined}
        onOpenLink={() => true}
        canOpenLink={() => true}
        day={facts.day}
        retry={undefined}
        startsThreads={false}
      />
    </ChannelRowPresentationContext.Provider>
  ) : null;
}
function Rows({ owner }: { owner: ChannelPresentation }) {
  const view = useSyncExternalStore(
    owner.subscribeView,
    owner.view,
    owner.view,
  );
  return (
    <ChannelPresentationContext.Provider value={owner}>
      {view.ids.map((id) => (
        <PresentedRow key={id} owner={owner} id={id} />
      ))}
    </ChannelPresentationContext.Provider>
  );
}

it("resolves explicit unmentioned profile links initially and after name/agent replacement", () => {
  const target = "cd".repeat(32),
    href = profileTarget(target);
  if (!href) throw new Error("Invalid fixture identity");
  const f = mountedFixture([
    row("explicit", { content: `[Authored](${href})` }),
  ]);
  f.profile(target, { name: "Current person" });
  f.library([{ pubkey: target, name: "Configured agent" }]);
  const owner = createChannelPresentation(f.session, "room", {
    chat: false,
    viewer: undefined,
  });
  const view = render(
    <StrictMode>
      <Rows owner={owner} />
    </StrictMode>,
  );
  const link = screen.getByRole("button", {
    name: "View Current person profile",
  });
  expect(link).toHaveAttribute("data-mention-kind", "agent");
  expect(link).toHaveAttribute("data-profile-target", href);
  link.focus();
  act(() => {
    f.profile(target, { name: "Replacement person" });
    f.library([]);
  });
  const replaced = screen.getByRole("button", {
    name: "View Replacement person profile",
  });
  expect(replaced).toBe(link);
  expect(replaced).toHaveFocus();
  expect(replaced).toHaveAttribute("data-mention-kind", "person");
  view.unmount();
  expect(
    [...f.sources.values()].every((listeners) => listeners.size === 0),
  ).toBe(true);
});

it.each(["See &#35;team_name", "See #team\\_name"])(
  "preserves parsed channel prose %s through list replacement",
  (content) => {
    const f = mountedFixture([row("prose", { content })]);
    f.channel({ name: "team_name" });
    const owner = createChannelPresentation(f.session, "room", {
      chat: false,
      viewer: undefined,
    });
    const view = render(
      <StrictMode>
        <Rows owner={owner} />
      </StrictMode>,
    );
    const prose = screen.getByRole("link", { name: /team_name/ });
    expect(prose).toHaveAttribute("href", "buzz://channel/room");
    act(() => f.channel({ name: "elsewhere" }));
    expect(screen.queryByRole("link", { name: /team_name/ })).toBeNull();
    expect(view.container.textContent).toContain("#team_name");
  },
);

it("keeps private channel metadata for decoded link destinations and updates it", () => {
  const f = mountedFixture([
    row("private", {
      content: "[Private destination](buzz&#58;//channel/room)",
    }),
  ]);
  f.channel({ name: "team_name", private: true });
  const owner = createChannelPresentation(f.session, "room", {
    chat: false,
    viewer: undefined,
  });
  const view = render(
    <StrictMode>
      <Rows owner={owner} />
    </StrictMode>,
  );
  const link = screen.getByRole("link", { name: "Private destination" });
  const lock = renderToStaticMarkup(
    <LockIcon className={referenceStyles.icon} />,
  );
  expect(link.innerHTML).toContain(lock);
  act(() => f.channel(({ private: _, ...channel }) => channel));
  expect(screen.getByRole("link", { name: "Private destination" })).toBe(link);
  expect(link.innerHTML).not.toContain(lock);
  view.unmount();
});

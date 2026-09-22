import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { MagnifyingGlassIcon } from "../../shared/design-system/icons/index";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
import type { RegisteredPage } from "../../features/pages/service";
import { communityDestination } from "../../features/communities/destination";
import { useRelayConnection } from "../../features/relay/react";
import type { AppServices } from "../services";
import {
  orderPages,
  pagePresentation,
  shellPresentation,
} from "./presentation";
import {
  SearchChoices,
  type SearchInputProps,
  type SearchDestination,
} from "./SearchChoices";
import { SearchResults } from "./SearchResults";

export type SearchServices = Pick<
  AppServices,
  "communities" | "shortcuts" | "navigation"
>;

export function PageSearch({
  pages,
  onSelect,
  services,
}: {
  pages: readonly RegisteredPage[];
  onSelect: (key: string) => void;
  services?: SearchServices | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const input = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const begin = useCallback(() => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : trigger.current;
    setQuery("");
    setOpen(true);
  }, []);
  useEffect(
    () =>
      services?.shortcuts.registerHost({
        id: "global-search",
        title: "Search Buzz",
        binding: { key: "k", mod: true },
        allowInEditable: true,
        run: begin,
      }),
    [services, begin],
  );
  const destinations: SearchDestination[] = [
    { key: "home", ...shellPresentation.home },
    ...orderPages(pages).map((page) => ({
      key: page.key,
      ...pagePresentation(page),
    })),
    { key: "settings", ...shellPresentation.settings },
  ]
    .filter((page) =>
      page.label.toLowerCase().includes(query.trim().toLowerCase()),
    )
    .map((page) => ({
      ...page,
      run: () => {
        returnFocus.current = document.getElementById("main-content");
        onSelect(page.key);
        setOpen(false);
      },
    }));
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl+K";
  return (
    <>
      <IconButton
        ref={trigger}
        variant="chrome"
        shape="round"
        aria-label="Search Buzz"
        title={`Search Buzz (${shortcut})`}
        onClick={() => {
          trigger.current?.focus();
          begin();
        }}
        icon={<MagnifyingGlassIcon size={16} aria-hidden="true" />}
      />
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Search Buzz"
        closeLabel="Close search"
        initialFocus={input}
        finalFocus={returnFocus}
      >
        {open &&
          (services ? (
            <CommunitySearch
              services={services}
              pages={destinations}
              query={query}
              onQueryChange={setQuery}
              input={input}
              enabled={pages.some(
                (page) => page.key === "buzz.channels/channels",
              )}
              close={() => {
                returnFocus.current = document.getElementById("main-content");
                setOpen(false);
              }}
            />
          ) : (
            <SearchChoices
              query={query}
              onQueryChange={setQuery}
              input={input}
              groups={[{ label: "Pages", destinations }]}
            />
          ))}
      </Dialog>
    </>
  );
}

function CommunitySearch({
  services,
  pages,
  query,
  onQueryChange,
  input,
  enabled,
  close,
}: {
  services: SearchServices;
  pages: readonly SearchDestination[];
  enabled: boolean;
  close: () => void;
} & SearchInputProps) {
  const client = useSyncExternalStore(
    services.communities.subscribe,
    services.communities.snapshot,
  );
  const connection = useRelayConnection(services.communities.relay);
  if (
    !enabled ||
    !client.selected ||
    !client.viewer ||
    connection.status !== "ready"
  ) {
    return (
      <SearchChoices
        query={query}
        onQueryChange={onQueryChange}
        input={input}
        groups={[{ label: "Pages", destinations: pages }]}
      >
        <div className="px-3 text-body-sm text-subtle" aria-live="polite">
          {!enabled ? (
            "Enable Messages to search conversations."
          ) : !client.selected ? (
            "Choose a community to search its conversations and messages."
          ) : ["error", "disconnected"].includes(connection.status) ? (
            <>
              <p>
                Message search is unavailable while this community is
                disconnected.
              </p>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => services.communities.relay.retry()}
              >
                Retry connection
              </Button>
            </>
          ) : (
            "Connecting to this community…"
          )}
        </div>
      </SearchChoices>
    );
  }
  const scope = {
    viewer: client.viewer,
    communityOrigin: communityDestination(client.selected).url,
  };
  return (
    <SearchResults
      key={`${client.selected}:${connection.scope}:${connection.generation}`}
      session={connection.session}
      query={query}
      onQueryChange={onQueryChange}
      input={input}
      pages={pages}
      openConversation={(channelId, messageId) => {
        const current = services.communities.snapshot();
        if (
          current.viewer !== scope.viewer ||
          current.selected !== client.selected ||
          services.communities.relay.snapshot().session !==
            connection.session ||
          !connection.session.channels
            .list()
            .channels.some((channel) => channel.id === channelId)
        )
          return;
        close();
        void services.navigation.open({
          version: 1,
          kind: "conversation",
          scope,
          channelId,
          ...(messageId ? { messageId } : {}),
        });
      }}
    />
  );
}

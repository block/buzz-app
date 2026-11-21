import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Navigation } from "../../features/navigation/controller";
import { useIdentityNames } from "../../features/identity-names/react";
import { formatPublicKey } from "../../shared/identity/public-key";
import { avatarMedia } from "../../shared/avatar-source";
import { buzzLinkTarget } from "../../features/navigation/buzz-links";
import { targetKey } from "../../features/navigation/targets";
import {
  noteKey,
  noteAddress,
  noteUrl,
  parseNoteUrl,
  type Note,
  type NoteAddress,
} from "./model";
import type { NotesWorkspace } from "./workspace";
import { useNotesCollection, useTrashTitles } from "./collection";
import { noteDisplayTitle } from "./NoteMetadata";
import type { PageProps } from "../../features/pages/service";
import { usePagesUi } from "./ui";
import type { PanelProps } from "../../features/panels/service";
import {
  useRelayConnection,
  useProfileGeneration,
} from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { NoteIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Panel } from "../../shared/design-system/ui/Panel";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { NoteDocument, type NoteFocus } from "./NoteDocument";
import { NewNoteDocument, type NewDraft } from "./NewNoteDocument";
import { NotesPage } from "./NotesPage";
import styles from "./WorkingNotes.module.css";
import {
  workingRoute,
  workingTarget,
  type WorkingRoute,
} from "./working-route";

export type NotesOwner = (session: RelaySession) => NotesWorkspace;

function openBuzzLink(
  navigator: Navigation | undefined,
  session: RelaySession,
  url: string,
) {
  const target = buzzLinkTarget(url, {
    viewer: session.viewer ?? "",
    communityOrigin: session.scope.replace(/:[0-9a-f]{64}$/, ""),
  });
  if (!navigator || !target) return false;
  void navigator.open(target);
  return true;
}
export function WorkingNotesPage({
  relay,
  getWorkspace,
  navigator,
  navigation,
  ...props
}: PageProps & {
  relay: RelayData;
  getWorkspace: NotesOwner;
  navigator: Navigation;
}) {
  const connection = useRelayConnection(relay);
  const request = useMemo(
    () => navigation?.forSession(relay, connection),
    [navigation, relay, connection],
  );
  useEffect(() => {
    if (
      request?.target.kind !== "page" ||
      request.target.scope ||
      connection.status !== "ready" ||
      !connection.viewer ||
      !connection.scope
    )
      return;
    request.resolve({
      ...request.target,
      scope: {
        viewer: connection.viewer,
        communityOrigin: connection.scope.slice(
          0,
          -(connection.viewer.length + 1),
        ),
      },
    });
  }, [request, connection]);
  if (connection.status !== "ready")
    return (
      <Panel aria-label="Docs" aria-busy={connection.status === "connecting"}>
        <PanelHeader
          title={
            <PanelHeaderLabel title="Docs" icon={<NoteIcon size={16} />} />
          }
        />
        {connection.status !== "connecting" && (
          <div className={styles.browser}>
            <p>Connect to your community to open docs.</p>
            {connection.status === "error" && (
              <>
                <p role="alert">{connection.error}</p>
                <Button onClick={() => relay.retry()}>Retry connection</Button>
              </>
            )}
          </div>
        )}
      </Panel>
    );
  const route =
    request?.target.kind === "page"
      ? workingRoute(request.target.route?.params)
      : undefined;
  if (route?.community && route.community !== connection.origin)
    return <p role="status">Connect to this doc’s community to open it.</p>;
  return (
    <WorkingNotesCommunity
      key={`${connection.scope}:${connection.generation}`}
      workspace={getWorkspace(connection.session)}
      relay={relay}
      navigator={navigator}
      navigation={navigation}
      {...props}
    />
  );
}

export function WorkingNotesCommunity({
  workspace,
  relay,
  navigator,
  navigation,
}: PageProps & {
  workspace: NotesWorkspace;
  relay?: RelayData;
  navigator?: Navigation;
}) {
  const request = relay
    ? navigation?.forSession(relay, relay.snapshot())
    : undefined;
  const requestedDestination = useMemo(
    () =>
      request?.target.kind === "page"
        ? workingRoute(request.target.route?.params)
        : undefined,
    [request],
  );
  const presentedDestination = useRef(requestedDestination);
  useLayoutEffect(() => {
    if (request) presentedDestination.current = requestedDestination;
  }, [request, requestedDestination]);
  // The host briefly unbinds navigation between visits. Keep the current
  // document visible so rebinding does not replay its opening focus.
  const destination = request
    ? requestedDestination
    : presentedDestination.current;
  const initial = useMemo(
    () => (destination?.view === "page" ? noteAddress(destination) : undefined),
    [destination],
  );
  const searchRef = useRef<HTMLElement>(null);
  const { collection, loading, error, showRefresh, load, changed, remove } =
    useNotesCollection(workspace);
  const [query, setQuery] = useState(destination?.query ?? "");
  const [trash, setTrash] = useState(destination?.trash ?? false);
  const trashTitles = useTrashTitles(workspace, collection.notes, trash);
  const title = (note: Note) =>
    noteDisplayTitle(note, trashTitles.get(note.revision));
  const { profiles, viewer } = workspace.session;
  const identities = useMemo(
    () =>
      [...new Set(collection.notes.map((note) => note.event.pubkey))].sort(),
    [collection.notes],
  );
  const profileMap = useSyncExternalStore(
    profiles.subscribe,
    profiles.snapshot,
  );
  const resolveName = useIdentityNames(workspace.session.names);
  const generation = useProfileGeneration(profiles);
  useEffect(() => {
    void generation;
    const release = profiles.reserve?.(identities.length);
    // Use the shared directory's budget and de-duplicated background reads.
    // Missing editor profiles use public-key labels.
    void profiles
      .ensure(identities.slice(0, profiles.limit?.()), "background")
      .catch(() => {});
    return release;
  }, [profiles, identities, generation]);
  const drafts = useRef(new Map<string, NewDraft>());
  const createdDrafts = useRef(new Map<string, NoteAddress>());
  const createdFocus = useRef(new Map<string, NoteFocus>());
  const [opened, setOpened] = useState<NoteAddress[]>(() =>
    initial ? [initial] : [],
  );
  const [selected, setSelected] = useState(
    initial ? noteKey(initial) : "browse",
  );
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const reveal = useCallback((address: NoteAddress) => {
    setOpened((old) =>
      old.some((item) => noteKey(item) === noteKey(address))
        ? old
        : [...old, { id: address.id, channel: address.channel }],
    );
    setSelected(noteKey(address));
  }, []);
  const visit = useCallback(
    (next: WorkingRoute, replace = false) => {
      if (
        !navigator ||
        !request ||
        request.signal.aborted ||
        request.target.kind !== "page" ||
        navigator.snapshot().entry.id !== request.entryId
      )
        return;
      const target = workingTarget(request.target, next);
      if (targetKey(target) === targetKey(navigator.snapshot().entry.target))
        return;
      void navigator.open(target, {
        focus: "preserve",
        replace,
      });
    },
    [navigator, request],
  );
  const open = (address: NoteAddress, replace = false) => {
    reveal(address);
    visit(
      {
        view: "page",
        ...noteAddress(address),
        query,
        trash,
      },
      replace,
    );
  };
  const browse = () => {
    setSelected("browse");
    visit({ view: "browse", query, trash });
    requestAnimationFrame(() => searchRef.current?.focus());
  };
  const newNote = (draft: Omit<NewDraft, "id">) => {
    const next = { ...draft, id: crypto.randomUUID() };
    drafts.current.set(next.id, next);
    setSelected(`new:${next.id}`);
    visit({
      view: "new",
      draft: next.id,
      query,
      trash,
    });
  };
  useEffect(() => {
    if (!request || !destination) return;
    if (initial) reveal(initial);
    else setSelected("browse");
    setQuery(destination.query ?? "");
    setTrash(destination.trash ?? false);
    if (destination.view === "new" && destination.draft) {
      const created = createdDrafts.current.get(destination.draft);
      if (created) {
        reveal(created);
        const { draft: _draft, ...rest } = destination;
        visit({ ...rest, view: "page", ...created }, true);
      } else {
        if (!drafts.current.has(destination.draft))
          drafts.current.set(destination.draft, {
            id: destination.draft,
            title: "",
            markdown: "",
          });
        setSelected(`new:${destination.draft}`);
      }
    }
  }, [request, initial, destination, reveal, visit]);
  const visible = collection.notes.filter((note) => note.deleted === trash);
  return (
    <NotesPage
      community={workspace.session.scope.replace(/:[0-9a-f]{64}$/, "")}
      author={(note) => {
        const key = note.event.pubkey;
        const profile = profileMap.get(key);
        return {
          name:
            key === viewer
              ? "You"
              : resolveName(key, profile?.name ?? formatPublicKey(key) ?? key),
          picture: avatarMedia(profile?.picture, workspace.session.media),
          isAgent: !!profile?.isAgent,
        };
      }}
      {...{
        selected,
        title,
        query,
        trash,
        searchRef,
        loading,
        showRefresh,
        more: collection.more,
        error,
        search: (value, commit) => {
          setQuery(value);
          if (commit)
            visit({
              ...(destination ?? { view: "browse" }),
              query: value,
              trash,
            });
        },
        openTrash: (value) => {
          setTrash(value);
          setQuery("");
          visit({
            view: "browse",
            trash: value,
          });
          requestAnimationFrame(() => searchRef.current?.focus());
        },
        create: () => newNote({ title: "", markdown: "" }),
        refresh: () => {
          void load();
        },
        loadMore: () => {
          void load(true);
        },
        browse,
        entries: visible,
        open,
        items: [
          ...opened.map((address) => {
            const key = noteKey(address);
            const note = collection.notes.find((note) => noteKey(note) === key);
            return {
              id: key,
              label: note ? title(note) : "Doc",
              content: (
                <NoteDocument
                  address={address}
                  initialFocus={createdFocus.current.get(key)}
                  workspace={workspace}
                  active={selected === key}
                  view={
                    selected === key &&
                    destination?.view === "page" &&
                    initial &&
                    noteKey(initial) === key
                      ? destination
                      : undefined
                  }
                  onViewChange={
                    selected === key
                      ? (view) =>
                          visit({
                            view: "page",
                            ...noteAddress(address),
                            query,
                            trash,
                            ...view,
                          })
                      : undefined
                  }
                  onOpen={open}
                  onOpenLink={(url) =>
                    openBuzzLink(navigator, workspace.session, url)
                  }
                  onUnavailable={(missing) => remove([missing.channel])}
                  onChange={changed}
                />
              ),
            };
          }),
          ...[...drafts.current.values()].map((draft) => ({
            id: `new:${draft.id}`,
            label: "New doc",
            content: (
              <NewNoteDocument
                workspace={workspace}
                initial={draft}
                active={selected === `new:${draft.id}`}
                onDraftChange={(next) => drafts.current.set(next.id, next)}
                onCreated={(note, focus) => {
                  if (focus) createdFocus.current.set(noteKey(note), focus);
                  createdDrafts.current.set(draft.id, noteAddress(note));
                  drafts.current.delete(draft.id);
                  changed(note);
                  if (selectedRef.current === `new:${draft.id}`)
                    open(note, true);
                }}
              />
            ),
          })),
        ],
      }}
    />
  );
}

/** The channel owns this tab; linked views retain drafts while moving back. */
export function WorkingNotePanel({
  target,
  relay,
  getWorkspace,
  navigator,
  context,
}: PanelProps & {
  relay: RelayData;
  getWorkspace: NotesOwner;
  navigator: Navigation;
}) {
  const connection = useRelayConnection(relay);
  const initial = useMemo(() => parseNoteUrl(target), [target]);
  if (
    !initial ||
    connection.status !== "ready" ||
    initial.community !== connection.origin
  )
    return (
      <div className={styles.browser}>
        <p role="status">Connect to this doc’s community to open it.</p>
      </div>
    );
  return (
    <NotePanelContents
      key={`${connection.scope}:${connection.generation}:${noteKey(initial)}`}
      initial={initial}
      workspace={getWorkspace(connection.session)}
      navigator={navigator}
      context={context}
    />
  );
}

function NotePanelContents({
  initial,
  workspace,
  navigator,
  context,
}: {
  initial: NoteAddress;
  workspace: NotesWorkspace;
  navigator: Navigation;
  context: PanelProps["context"];
}) {
  const [title, setTitle] = useState("Doc");
  const communityOrigin = workspace.session.scope.replace(/:[0-9a-f]{64}$/, "");
  const viewer = workspace.session.viewer ?? "";
  const openInDocs = useCallback(
    (address: NoteAddress) => {
      void navigator.open({
        version: 1,
        kind: "page",
        pluginId: "com.squareup.pages",
        pageId: "pages",
        scope: { viewer, communityOrigin },
        route: {
          version: 1,
          params: { view: "page", ...noteAddress(address) },
        },
      });
    },
    [navigator, viewer, communityOrigin],
  );
  const showInDocs = useCallback(
    () => openInDocs(initial),
    [openInDocs, initial],
  );
  const tabActions = useMemo(
    () => [{ label: "Open in Docs", run: showInDocs }],
    [showInDocs],
  );
  usePagesUi().panels.useTabTitle?.(title, undefined, tabActions);
  const open = (address: NoteAddress) => {
    if (!context?.open(noteUrl(address, communityOrigin))) openInDocs(address);
  };
  return (
    <div className={styles.page}>
      <NoteDocument
        address={initial}
        workspace={workspace}
        onChange={(note) => setTitle(noteDisplayTitle(note))}
        onUnavailable={() => setTitle("Doc")}
        onOpen={open}
        onOpenInDocs={showInDocs}
        onOpenLink={(url) => openBuzzLink(navigator, workspace.session, url)}
      />
    </div>
  );
}

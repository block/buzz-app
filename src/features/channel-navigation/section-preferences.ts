import type { RelaySession } from "../relay/session";
import type { SidebarPreferences } from "../relay/sidebar-preferences";

type Owner = "solo" | "team";
type Preferences = RelaySession["sidebarPreferences"];
type Snapshot = ReturnType<Preferences["snapshot"]>;

/** Qualified UI identities keep existing records distinct, even when IDs match. */
export function sectionKey(owner: Owner, id: string) {
  return `section:${owner}:${encodeURIComponent(id)}`;
}
export function sectionOwner(key: string): { owner: Owner; id: string } {
  const match = /^section:(solo|team):(.*)$/.exec(key);
  if (match)
    return { owner: match[1] as Owner, id: decodeURIComponent(match[2] ?? "") };
  // Existing Solo draft URLs contain the original ID.
  return { owner: "solo", id: key };
}

const stores = new WeakMap<
  RelaySession,
  ReturnType<typeof createSectionPreferences>
>();
export function sectionPreferences(session: RelaySession) {
  let store = stores.get(session);
  if (!store) {
    store = createSectionPreferences(session);
    stores.set(session, store);
  }
  return store;
}

/** Feature projection only: the existing stores retain signing, readback and lifetime guards. */
function createSectionPreferences(session: RelaySession) {
  const solo = session.soloPreferences;
  const team = session.sidebarPreferences;
  const source = (owner: Owner) => (owner === "solo" ? solo : team);
  const listeners = new Set<() => void>();
  type Move = {
    id: number;
    channelId: string;
    destination: {
      sectionId?: string;
      starred?: true;
      createSection?: { id: string; name: string };
    };
    pending: boolean;
    error?: string;
  };
  const moves = new Map<string, Move>();
  let serial = Promise.resolve();
  let sequence = 0;
  let revision = 0;
  let cached:
    | { solo: Snapshot; team: Snapshot; revision: number; value: Snapshot }
    | undefined;
  const publish = () => {
    revision++;
    for (const listener of listeners) listener();
  };
  const snapshot = (): Snapshot => {
    const a = solo.snapshot();
    const b = team.snapshot();
    if (cached?.solo === a && cached.team === b && cached.revision === revision)
      return cached.value;
    const sections = [
      ...(a.data?.sections ?? []).map((section) => ({
        ...section,
        id: sectionKey("solo", section.id),
      })),
      ...(b.data?.sections ?? []).map((section) => ({
        ...section,
        id: sectionKey("team", section.id),
      })),
    ].map((section, order) => ({ ...section, order }));
    for (const move of moves.values()) {
      const created = move.destination.createSection;
      if (
        move.pending &&
        created &&
        move.destination.sectionId &&
        !sections.some((section) => section.id === move.destination.sectionId)
      )
        sections.push({
          id: move.destination.sectionId,
          name: created.name,
          order: sections.length,
        });
    }
    const valid = new Set(sections.map((section) => section.id));
    const assignments: Record<string, string> = {};
    // Stable precedence after an interrupted cross-record move. Retry completes the requested move.
    for (const [owner, state] of [
      ["team", b],
      ["solo", a],
    ] as const)
      for (const [channel, id] of Object.entries(
        state.data?.assignments ?? {},
      )) {
        const key = sectionKey(owner, id);
        if (valid.has(key)) assignments[channel] = key;
      }
    for (const move of moves.values())
      if (move.pending) {
        if (move.destination.sectionId)
          assignments[move.channelId] = move.destination.sectionId;
        else delete assignments[move.channelId];
      }
    const starred = new Set(b.data?.starred);
    for (const move of moves.values())
      if (move.pending) {
        if (move.destination.starred) starred.add(move.channelId);
        else starred.delete(move.channelId);
      }
    const projectKeys = <T>(record: Readonly<Record<string, T>> | undefined) =>
      Object.fromEntries(
        Object.entries(record ?? {}).map(([key, value]) => [
          key.startsWith("section:")
            ? `section:${sectionKey("team", key.slice(8))}`
            : key,
          value,
        ]),
      );
    const data: SidebarPreferences = {
      ...b.data,
      sections,
      assignments,
      sort: projectKeys(b.data?.sort),
      filters: projectKeys(b.data?.filters),
      activeWindowSeconds: projectKeys(b.data?.activeWindowSeconds),
      starred: [...starred],
      muted: b.data?.muted ?? [],
    };
    const states = [a, b];
    const error = states.find((state) => state.status === "error");
    const status = error
      ? "error"
      : states.some((state) => state.status === "idle")
        ? "idle"
        : states.some((state) => state.status === "loading")
          ? "loading"
          : states.every((state) => state.status === "unsupported")
            ? "unsupported"
            : "ready";
    const value: Snapshot = {
      ...b,
      ...(b.orderError
        ? {
            orderError: {
              ...b.orderError,
              sectionId: sectionKey("team", b.orderError.sectionId),
              sectionIds: b.orderError.sectionIds.map((id) =>
                sectionKey("team", id),
              ),
            },
          }
        : {}),
      sortErrors: (b.sortErrors ?? []).map((error) => ({
        ...error,
        group: error.group.startsWith("section:")
          ? `section:${sectionKey("team", error.group.slice(8))}`
          : error.group,
      })),
      filterErrors: (b.filterErrors ?? []).map((error) => ({
        ...error,
        group: error.group.startsWith("section:")
          ? `section:${sectionKey("team", error.group.slice(8))}`
          : error.group,
      })),
      status,
      ...(a.data || b.data ? { data } : {}),
      ...(error?.error ? { error: error.error } : {}),
      ...(a.cached || b.cached ? { cached: true } : {}),
      moves: [
        ...moves.values(),
        ...(b.moves ?? []).filter((move) => !moves.has(move.channelId)),
      ],
    };
    cached = { solo: a, team: b, revision, value };
    return value;
  };
  const usable = (store: Preferences) =>
    store.writable || store.snapshot().status === "unsupported";
  const writable = () =>
    usable(solo) && usable(team) && (solo.writable || team.writable);
  const moveTo = (
    channelId: string,
    key?: string,
    signal?: AbortSignal,
    starred = false,
    createSection?: { id: string; name: string },
  ) => {
    if (!writable())
      return Promise.reject(
        new Error("Refresh sections before moving a conversation."),
      );
    const target = key ? sectionOwner(key) : undefined;
    const qualified = target ? sectionKey(target.owner, target.id) : undefined;
    if (
      qualified &&
      !createSection &&
      !snapshot().data?.sections.some((section) => section.id === qualified)
    )
      return Promise.reject(new Error("This section is no longer available."));
    const move: Move = {
      id: ++sequence,
      channelId,
      destination: starred
        ? { starred: true }
        : qualified
          ? {
              sectionId: qualified,
              ...(createSection ? { createSection } : {}),
            }
          : {},
      pending: true,
    };
    moves.set(channelId, move);
    publish();
    const lifetime = new AbortController();
    const retire = () => {
      if ([solo, team].some((store) => store.snapshot().status === "idle"))
        lifetime.abort();
    };
    const stopSolo = solo.subscribe(retire);
    const stopTeam = team.subscribe(retire);
    const active = AbortSignal.any([
      lifetime.signal,
      ...(signal ? [signal] : []),
    ]);
    const run = serial
      .then(async () => {
        active.throwIfAborted();
        // Confirm the destination before removing the old placement. Never erase both on a failed save.
        if (starred) await team.setStar(channelId, true, active);
        else if (target) {
          if (createSection)
            await source(target.owner).createAndAssign(
              channelId,
              { ...createSection, id: target.id },
              active,
            );
          else await source(target.owner).assign(channelId, target.id, active);
        }
        for (const owner of ["solo", "team"] as const) {
          active.throwIfAborted();
          if (
            !starred &&
            owner !== target?.owner &&
            source(owner).snapshot().status !== "unsupported"
          )
            await source(owner).assign(channelId, undefined, active);
        }
        if (moves.get(channelId) === move) moves.delete(channelId);
        solo.dismissMoveError(channelId);
        team.dismissMoveError(channelId);
        const data = snapshot().data;
        if (!data)
          throw new Error("Sections are unavailable. Refresh and retry.");
        return data;
      })
      .catch((error: unknown) => {
        if (active.aborted && moves.get(channelId) === move)
          moves.delete(channelId);
        else if (moves.get(channelId) === move)
          moves.set(channelId, {
            ...move,
            pending: false,
            error: error instanceof Error ? error.message : String(error),
          });
        throw error;
      })
      .finally(() => {
        stopSolo();
        stopTeam();
        publish();
      });
    serial = run.then(
      () => {},
      () => {},
    );
    return run;
  };
  const assign = (channelId: string, key?: string, signal?: AbortSignal) =>
    moveTo(channelId, key, signal);
  const overrides = {
    snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      const a = solo.subscribe(listener);
      const b = team.subscribe(listener);
      return () => {
        listeners.delete(listener);
        a();
        b();
      };
    },
    ensure: async () => {
      await Promise.all([solo.ensure(), team.ensure()]);
    },
    refresh: async () => {
      await Promise.all([solo.refresh(), team.refresh()]);
    },
    get writable() {
      return writable();
    },
    get sectionCreationWritable() {
      return solo.snapshot().status === "unsupported"
        ? team.sectionCreationWritable
        : solo.sectionCreationWritable;
    },
    get sectionRemovalWritable() {
      return solo.sectionRemovalWritable || team.removeSectionWritable;
    },
    get removeSectionWritable() {
      return this.sectionRemovalWritable;
    },
    createSection(section: { id: string; name: string }) {
      const target =
        !section.id.startsWith("section:") &&
        solo.snapshot().status === "unsupported"
          ? { owner: "team" as const, id: section.id }
          : sectionOwner(section.id);
      return source(target.owner).createSection({ ...section, id: target.id });
    },
    createAndAssign(
      channelId: string,
      section: { id: string; name: string; position?: "first" },
      signal?: AbortSignal,
    ) {
      const key =
        !section.id.startsWith("section:") &&
        solo.snapshot().status === "unsupported"
          ? sectionKey("team", section.id)
          : section.id;
      return moveTo(channelId, key, signal, false, section);
    },
    removeSection(key: string, signal?: AbortSignal) {
      const target = sectionOwner(key);
      return source(target.owner).removeSection(target.id, signal);
    },
    renameSection(key: string, name: string) {
      const target = sectionOwner(key);
      return source(target.owner).renameSection(target.id, name);
    },
    assign,
    retryMove(channelId: string) {
      const move = moves.get(channelId);
      return move
        ? moveTo(
            channelId,
            move.destination.sectionId,
            undefined,
            !!move.destination.starred,
            move.destination.createSection,
          )
        : team.retryMove(channelId);
    },
    dismissMoveError(channelId: string) {
      moves.delete(channelId);
      solo.dismissMoveError(channelId);
      team.dismissMoveError(channelId);
      publish();
    },
  };
  return {
    ...overrides,
    get writable() {
      return writable();
    },
    get sectionCreationWritable() {
      return solo.snapshot().status === "unsupported"
        ? team.sectionCreationWritable
        : solo.sectionCreationWritable;
    },
    get sectionRemovalWritable() {
      return solo.sectionRemovalWritable || team.removeSectionWritable;
    },
    get removeSectionWritable() {
      return solo.sectionRemovalWritable || team.removeSectionWritable;
    },
    available: solo.available || team.available,
    get starWritable() {
      return writable() && team.starWritable;
    },
    async setStar(channelId: string, starred: boolean, signal?: AbortSignal) {
      return (await moveTo(channelId, undefined, signal, starred)).starred;
    },
    get muteWritable() {
      return team.muteWritable;
    },
    setMute: team.setMute,
    // Group ordering/filter controls are not offered by the common section renderer.
    get sectionOrderWritable() {
      return team.sectionOrderWritable;
    },
    get sectionRenameWritable() {
      return solo.sectionRenameWritable || team.sectionRenameWritable;
    },
    canRenameSection(key: string) {
      return source(sectionOwner(key).owner).sectionRenameWritable;
    },
    canRemoveSection(key: string) {
      const store = source(sectionOwner(key).owner);
      return store.sectionRemovalWritable;
    },
    reorderSections: (key: string, ids: readonly string[]) => {
      const target = sectionOwner(key);
      return source(target.owner).reorderSections(
        target.id,
        ids
          .map(sectionOwner)
          .filter((section) => section.owner === target.owner)
          .map((section) => section.id),
      );
    },
    dismissOrderError: team.dismissOrderError,
    get sortWritable() {
      return team.sortWritable;
    },
    setSort: ((group, mode, _ids, signal) => {
      if (group.startsWith("section:")) {
        const target = sectionOwner(group.slice(8));
        if (target.owner !== "team")
          return Promise.reject(
            new Error("Sorting this section is unavailable."),
          );
        group = `section:${target.id}`;
      }
      return team.setSort(
        group,
        mode,
        team.snapshot().data?.sections.map((section) => section.id) ?? [],
        signal,
      );
    }) as Preferences["setSort"],
    dismissSortError: (group: string) =>
      team.dismissSortError(
        group.startsWith("section:")
          ? `section:${sectionOwner(group.slice(8)).id}`
          : group,
      ),
    get filterWritable() {
      return team.filterWritable;
    },
    setFilter: ((group, mode, _ids, signal, seconds) => {
      if (group.startsWith("section:")) {
        const target = sectionOwner(group.slice(8));
        if (target.owner !== "team")
          return Promise.reject(
            new Error("Filtering this section is unavailable."),
          );
        group = `section:${target.id}`;
      }
      return team.setFilter(
        group,
        mode,
        team.snapshot().data?.sections.map((section) => section.id) ?? [],
        signal,
        seconds,
      );
    }) as Preferences["setFilter"],
    dismissFilterError: (group: string) =>
      team.dismissFilterError(
        group.startsWith("section:")
          ? `section:${sectionOwner(group.slice(8)).id}`
          : group,
      ),
    async read() {
      await overrides.refresh();
      const data = snapshot().data;
      if (!data)
        throw new Error("Sections are unavailable. Refresh and retry.");
      return data;
    },
  };
}

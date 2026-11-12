import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { IconButton } from "../shared/design-system/ui/IconButton";
import {
  KeyboardIcon,
  PencilSimpleIcon,
  XIcon,
} from "../shared/design-system/icons";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { SwitchPreferenceRow } from "../shared/design-system/ui/SwitchPreferenceRow";
import { Header, InlineHeader } from "../shared/design-system/ui/Header";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Button } from "../shared/design-system/ui/Button";
import { EmptyState } from "../shared/design-system/ui/EmptyState";
import { SearchField } from "../shared/design-system/ui/SearchField";
import {
  sameBinding,
  type KeyBinding,
  type NormalizedShortcut,
} from "../features/shortcuts/bindings";
import { formatBinding, isApplePlatform } from "../features/shortcuts/format";
import {
  composerFormats,
  formatBindings,
  linkBindings,
  pressesFormat,
} from "../features/messages/composer-dom";
import { KeyCombo } from "../features/shortcuts/KeyCombo";
import {
  KeyCaptureControl,
  type CapturedChord,
} from "../features/shortcuts/KeyCaptureControl";
import type { ShortcutBindings } from "../features/shortcuts/preferences";
import {
  searchEntry,
  shortcutFilter,
  shownChords,
  type KeyPress,
  type ShortcutSearch,
} from "../features/shortcuts/search";
import type { ShortcutsService } from "../features/shortcuts/service";
import {
  sendKeyPreference,
  useSendWithModEnterPreference,
} from "../features/messages/send-key-preference";
import type { PluginManager } from "../plugins/manager";
import { editKeyPreference } from "../features/messages/edit-key-preference";

type Row = Readonly<{
  key: string;
  title: string;
  owner: string;
  /** Owner-defined presentation order within the Settings category. */
  order: number;
  /** Native close/quit defaults are reserved, not user-rebindable. */
  readOnly: boolean;
  defaults: readonly KeyBinding[];
  override: KeyBinding | undefined;
  effective: readonly KeyBinding[];
}>;
type Group = Readonly<{
  id: string;
  label: string;
  /** Stable owner identity for equal display labels. */
  sortKey: string;
  /** Said once under the heading; its read-only rows then need no note each. */
  description?: string;
  rows: readonly Row[];
}>;
const NO_SEARCH: ShortcutSearch = { kind: "text", text: "" };
const NO_ROWS: readonly Row[] = [];
type Notice = Readonly<{
  key: string;
  tone: "error" | "warning";
  message: string;
}>;

/** The message editor's own keys, shown read-only: it handles them before any shortcut. */
const editorRows = (sendWithModEnter: boolean): readonly Row[] =>
  [
    ...composerFormats.map((format) => ({
      title: format.label,
      bindings: formatBindings(format),
    })),
    { title: "Add or edit link", bindings: linkBindings },
    { title: "Undo", bindings: [{ key: "z", mod: true }] },
    {
      title: "Redo",
      bindings: [
        { key: "z", mod: true, shift: true },
        { key: "y", mod: true },
      ],
    },
    {
      title: "Send message",
      bindings: [
        sendWithModEnter ? { key: "Enter", mod: true } : { key: "Enter" },
      ],
    },
    {
      title: "New line",
      bindings: sendWithModEnter
        ? [{ key: "Enter" }, { key: "Enter", shift: true }]
        : [{ key: "Enter", shift: true }],
    },
  ].map(({ title, bindings }, order) => ({
    key: `editor:${title}`,
    title,
    owner: "Message formatting",
    order,
    readOnly: true,
    defaults: bindings,
    override: undefined,
    effective: bindings,
  }));
/** Recorded keys find editor rows as the editor matches them, by physical key too. */
const editorPresses =
  (chords: readonly KeyBinding[]) =>
  ({ chord, code }: KeyPress) =>
    !!chord.mod &&
    !chord.ctrl &&
    chords.some(
      (binding) =>
        !!binding.mod &&
        !binding.ctrl &&
        pressesFormat(
          {
            key: binding.key,
            mod: true,
            shift: !!binding.shift,
            alt: !!binding.alt,
          },
          {
            key: chord.key.toLowerCase(),
            code,
            shift: !!chord.shift,
            alt: !!chord.alt,
          },
        ),
    );
const EDITOR_FORMAT_CHORDS = editorRows(false).flatMap((row) => row.effective);

/** Chords the message editor handles locally before the window dispatcher: undo/redo and line/document jumps. */
const EDITOR_CHORDS: readonly KeyBinding[] = [
  { key: "z", mod: true },
  { key: "z", mod: true, shift: true },
  { key: "y", mod: true },
  { key: "y", mod: true, shift: true },
  { key: "Home", mod: true },
  { key: "Home", mod: true, shift: true },
  { key: "End", mod: true },
  { key: "End", mod: true, shift: true },
];
/** Copy, paste, cut and select all: a matching shortcut would preventDefault them everywhere. */
const CLIPBOARD_CHORDS: readonly KeyBinding[] = [
  { key: "c", mod: true },
  { key: "v", mod: true },
  { key: "v", mod: true, shift: true },
  { key: "x", mod: true },
  { key: "a", mod: true },
];
/** Switch tab, close tab and quit: the desktop shell owns these, so they stay fixed. */
const DESKTOP_CHORDS: readonly KeyBinding[] = [
  { key: "q", mod: true },
  { key: "w", mod: true },
  { key: "Tab", mod: true },
  { key: "Tab", mod: true, shift: true },
];
const includes = (chords: readonly KeyBinding[], binding: KeyBinding) =>
  chords.some((chord) => sameBinding(chord, binding));
/** Every owner supplies order; identity and title make ties deterministic. */
const byPresentation = (a: Row, b: Row) =>
  a.order - b.order ||
  a.key.localeCompare(b.key) ||
  a.title.localeCompare(b.title);

/**
 * Every listed shortcut, grouped as Settings shows them: host,
 * then plugins by name, then the editor's read-only keys. `rows` are only the
 * dispatcher's, which are the ones that can conflict or be rebound.
 */
function useShortcutGroups({
  shortcuts,
  bindings,
  plugins,
  desktop = isTauri(),
}: {
  shortcuts: ShortcutsService;
  bindings: ShortcutBindings;
  plugins: Pick<PluginManager, "subscribe" | "snapshot">;
  desktop?: boolean;
}) {
  const host = useSyncExternalStore(
    shortcuts.hostSubscribe,
    shortcuts.hostSnapshot,
  );
  const contributed = useSyncExternalStore(
    shortcuts.subscribe,
    shortcuts.snapshot,
  );
  const { overrides, error } = useSyncExternalStore(
    bindings.subscribe,
    bindings.snapshot,
  );
  const { configuration } = useSyncExternalStore(
    plugins.subscribe,
    plugins.snapshot,
  );
  const sendWithModEnter = useSendWithModEnterPreference();

  // Built once per registry, binding or catalog change, so a filter keystroke
  // reuses every row and memoized rows skip rendering.
  return useMemo(
    () =>
      shortcutGroups({
        host,
        contributed,
        overrides,
        error,
        configuration,
        sendWithModEnter,
        desktop,
      }),
    [
      host,
      contributed,
      overrides,
      error,
      configuration,
      sendWithModEnter,
      desktop,
    ],
  );
}

function shortcutGroups({
  host,
  contributed,
  overrides,
  error,
  configuration,
  sendWithModEnter,
  desktop,
}: {
  host: readonly NormalizedShortcut[];
  contributed: ReturnType<ShortcutsService["snapshot"]>;
  overrides: ReturnType<ShortcutBindings["snapshot"]>["overrides"];
  error: ReturnType<ShortcutBindings["snapshot"]>["error"];
  configuration: ReturnType<PluginManager["snapshot"]>["configuration"];
  sendWithModEnter: boolean;
  desktop: boolean;
}) {
  const pluginName = (id: string) =>
    (configuration.status === "ready"
      ? configuration.catalog.plugins.find(
          (plugin) => plugin.manifest.id === id,
        )?.manifest.name
      : undefined) ?? id;
  const row = (
    key: string,
    shortcut: NormalizedShortcut,
    owner: string,
    readOnly = false,
  ): Row => {
    const override = overrides[key];
    return {
      key,
      title: shortcut.title,
      owner,
      order: shortcut.order,
      readOnly,
      defaults: shortcut.binding,
      override,
      effective: override ? [override] : shortcut.binding,
    };
  };
  // Group ids are namespaced so a plugin whose manifest id is "buzz" or "host"
  // cannot share a React key with the host group.
  const groups: Group[] = [
    {
      id: "host",
      label: "Buzz",
      sortKey: "",
      rows: host.map((shortcut) =>
        row(
          shortcut.id,
          shortcut,
          "Buzz",
          desktop &&
            shortcut.binding.some((binding) =>
              includes(DESKTOP_CHORDS, binding),
            ),
        ),
      ),
    },
    ...[...new Set(contributed.map((shortcut) => shortcut.pluginId))]
      .map((pluginId) => {
        const label = pluginName(pluginId);
        return {
          id: `plugin:${pluginId}`,
          label,
          sortKey: pluginId,
          rows: contributed
            .filter((shortcut) => shortcut.pluginId === pluginId)
            .map((shortcut) => row(shortcut.key, shortcut, label)),
        };
      })
      .sort(
        (a, b) =>
          a.label.localeCompare(b.label) || a.sortKey.localeCompare(b.sortKey),
      ),
  ]
    .map((group) => ({
      ...group,
      rows: [...group.rows].sort(byPresentation),
    }))
    .filter((group) => group.rows.length);
  const rows = groups.flatMap((group) => group.rows);
  // Listed after the rows that can conflict: the editor keeps these while typing.
  const shownGroups: Group[] = [
    ...groups,
    {
      id: "editor",
      label: "Message formatting",
      sortKey: "editor",
      description:
        "Built into the message editor. These work while you type and can't be changed.",
      rows: editorRows(sendWithModEnter),
    },
  ];
  return { overrides, error, rows, shownGroups };
}

/** A row's distinct chords, "⌘K or ⌘T". */
function ShortcutChords({
  chords,
  apple,
}: {
  chords: readonly KeyBinding[];
  apple: boolean;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-body-sm text-subtle">
      {shownChords(chords).map((binding, index) => (
        <Fragment key={formatBinding(binding, apple).text}>
          {index > 0 && <span>or</span>}
          <KeyCombo binding={binding} apple={apple} />
        </Fragment>
      ))}
    </span>
  );
}

/**
 * Lists every host binding and every active plugin contribution from the live
 * dispatcher registry, so the page cannot drift from what actually fires.
 * Overrides are keyed by the registry's own identity: host id or `pluginId/id`.
 */
export function ShortcutSettings({
  shortcuts,
  bindings,
  plugins,
  apple = isApplePlatform(navigator.platform),
  desktop = isTauri(),
}: {
  shortcuts: ShortcutsService;
  bindings: ShortcutBindings;
  /** Display names for plugin groups come from the catalog. */
  plugins: Pick<PluginManager, "subscribe" | "snapshot">;
  apple?: boolean;
  /** Packaged desktop build, where close/quit chords belong to the shell. */
  desktop?: boolean;
}) {
  const { overrides, error, rows, shownGroups } = useShortcutGroups({
    shortcuts,
    bindings,
    plugins,
    desktop,
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [search, setSearch] = useState<ShortcutSearch>(NO_SEARCH);
  const searchInput = useRef<HTMLElement | null>(null);
  const sendChord = apple ? "⌘ Enter" : "Ctrl+Enter";
  // A chord can become shared after capture (a plugin enabled later, a new
  // default in a release). The dispatcher then picks one silently, so each
  // affected row names the others.
  const sharedWith = useMemo(
    () =>
      new Map(
        rows.map((target) => [
          target.key,
          rows.filter(
            (other) =>
              other.key !== target.key &&
              other.effective.some((binding) =>
                target.effective.some((current) =>
                  sameBinding(current, binding),
                ),
              ),
          ),
        ]),
      ),
    [rows],
  );
  const modified = Object.keys(overrides).length > 0;
  // Each row is prepared once per change to the rows, not per keystroke.
  const entries = useMemo(
    () =>
      new Map(
        shownGroups.flatMap((group) =>
          group.rows.map((row) => [
            row.key,
            searchEntry(
              row.title,
              group.label,
              row.effective,
              apple,
              group.id === "editor" ? editorPresses(row.effective) : undefined,
            ),
          ]),
        ),
      ),
    [shownGroups, apple],
  );
  const filter = useMemo(
    () =>
      search.kind === "keys" || search.text.trim()
        ? shortcutFilter(search, apple)
        : undefined,
    [search, apple],
  );
  const visibleGroups = useMemo(
    () =>
      filter
        ? shownGroups
            .map((group) => ({
              ...group,
              rows: group.rows.filter((row) => {
                const entry = entries.get(row.key);
                return !!entry && filter.matches(entry);
              }),
            }))
            .filter((group) => group.rows.length)
        : shownGroups,
    [filter, shownGroups, entries],
  );
  // The two switches match by their words, so "send" finds its setting.
  const preferences = [
    {
      title: "Sending messages",
      label: `Send with ${sendChord}`,
      description: `Enter adds a new line. ${sendChord} sends your message.`,
      preference: sendKeyPreference,
    },
    {
      title: "Editing messages",
      label: "Edit last message with Up Arrow",
      description:
        "When the composer is empty, Up Arrow edits your most recent editable message instead of selecting messages.",
      preference: editKeyPreference,
    },
  ].filter(
    ({ title, label }) =>
      !filter || filter.matches(searchEntry(label, title, [], apple)),
  );
  const found = visibleGroups.reduce(
    (count, group) => count + group.rows.length,
    preferences.length,
  );
  // A rebind or reset can take its row out of the results. Keep focus in the
  // search, and drop the row's notice rather than show it when the row returns.
  const rebound = useRef<string | null>(null);
  useEffect(() => {
    const key = rebound.current;
    rebound.current = null;
    if (
      !key ||
      !filter ||
      visibleGroups.some((group) => group.rows.some((row) => row.key === key))
    )
      return;
    setNotice((current) => (current?.key === key ? null : current));
    if (document.activeElement === document.body) searchInput.current?.focus();
  }, [filter, visibleGroups]);

  const start = useCallback((row: Row) => {
    setEditing(row.key);
    setNotice(null);
  }, []);
  const cancel = useCallback(({ key }: Row) => {
    setEditing((current) => (current === key ? null : current));
    setNotice((current) =>
      current?.key === key && current.tone === "error" ? null : current,
    );
  }, []);
  const reset = useCallback(
    (row: Row) => {
      cancel(row);
      setNotice(null);
      rebound.current = row.key;
      bindings.set(row.key, null);
    },
    [cancel, bindings],
  );
  // Conflicts are decided here, not in the dispatcher: host chords always win
  // there, and plugin ties resolve by sorted key, neither of which is a choice.
  const capture = useCallback(
    (target: Row, { binding, otherPrimary, code }: CapturedChord) => {
      const chord = formatBinding(binding, apple).text;
      const refuse = (message: string) =>
        setNotice({ key: target.key, tone: "error", message });
      if (binding.key === "Dead" || binding.key === "Unidentified")
        return refuse("That key can’t be used for a shortcut. Try another.");
      if (otherPrimary)
        return refuse(
          "The Windows/Command key isn’t used for shortcuts on this device. Try Control or Alt.",
        );
      if (!binding.mod && !binding.alt)
        return refuse(
          `Include ${apple ? "Command or Option" : "Control or Alt"} so ordinary typing keeps working.`,
        );
      // Apple's ⌥⇧⌘V browser paste types a layout-specific key, so match the physical V.
      const applePlainPaste =
        apple &&
        code === "KeyV" &&
        binding.mod &&
        binding.shift &&
        binding.alt &&
        !binding.ctrl;
      if (includes(CLIPBOARD_CHORDS, binding) || applePlainPaste)
        return refuse(
          `${chord} is reserved for copy, cut, paste and select all. Try another.`,
        );
      if (desktop && includes(DESKTOP_CHORDS, binding))
        return refuse(
          `${chord} is reserved for switching or closing tabs and quitting Buzz. Try another.`,
        );
      const conflict = rows.find(
        (row) =>
          row.key !== target.key &&
          row.effective.some((current) => sameBinding(current, binding)),
      );
      if (conflict)
        return refuse(
          `${chord} is already used by ${conflict.title} (${conflict.owner}).`,
        );
      const isDefault =
        target.defaults.length === 1 &&
        target.defaults.every((current) => sameBinding(current, binding));
      rebound.current = target.key;
      bindings.set(target.key, isDefault ? null : binding);
      setEditing(null);
      // EditableInput handles Enter locally regardless of the held modifiers.
      setNotice(
        binding.key === "Enter" ||
          includes(EDITOR_CHORDS, binding) ||
          includes(EDITOR_FORMAT_CHORDS, binding)
          ? {
              key: target.key,
              tone: "warning",
              message: `Saved. The message editor handles ${chord} itself while you are typing, so it wins there.`,
            }
          : null,
      );
    },
    [apple, desktop, rows, bindings],
  );

  return (
    // Escape clears an active search from anywhere here, before it reaches
    // Settings. A capture control consumes its own Escape first.
    <section
      aria-labelledby="shortcut-settings-title"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !filter) return;
        event.preventDefault();
        event.stopPropagation();
        setSearch(NO_SEARCH);
      }}
    >
      <Header id="shortcut-settings-title" title="Shortcuts" />
      <div className="grid gap-5">
        <ShortcutSearchBar
          search={search}
          apple={apple}
          inputRef={searchInput}
          onSearch={setSearch}
        />
        {/* The only result announcement: the count, or the empty state. */}
        <div role="status">
          {filter &&
            (found ? (
              <p className="sr-only">
                {found === 1 ? "1 result" : `${found} results`}
              </p>
            ) : (
              <EmptyState
                icon={<KeyboardIcon size={24} />}
                title={
                  filter.chord
                    ? `Nothing is mapped to ${formatBinding(filter.chord, apple).text}`
                    : "No shortcuts match"
                }
                description={
                  filter.chord
                    ? "Try other keys, or search by name."
                    : "Try another name, or search by keys."
                }
              />
            ))}
        </div>
        {preferences.map(({ title, label, description, preference }) => (
          <MessageKeyPreference
            key={title}
            title={title}
            label={label}
            description={description}
            preference={preference}
          />
        ))}
        {rows.length ? (
          <div className="grid gap-section-gap">
            {visibleGroups.map((group) => (
              <section key={group.id}>
                <InlineHeader
                  title={group.label}
                  subtitle={group.description}
                />
                <SettingsGroup>
                  {group.rows.map((row) => (
                    <ShortcutRow
                      key={row.key}
                      row={row}
                      explained={!!group.description}
                      apple={apple}
                      sharedWith={sharedWith.get(row.key) ?? NO_ROWS}
                      listening={editing === row.key}
                      notice={notice?.key === row.key ? notice : null}
                      onStart={start}
                      onCancel={cancel}
                      onCapture={capture}
                      onReset={reset}
                    />
                  ))}
                </SettingsGroup>
              </section>
            ))}
          </div>
        ) : (
          <p className="m-0 px-control-inset text-body-sm text-subtle">
            No shortcuts are available yet.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            disabled={!modified}
            onClick={() => {
              setEditing(null);
              setNotice(null);
              bindings.reset();
            }}
          >
            Reset all shortcuts
          </Button>
        </div>
        {error && (
          <div role="alert" className="grid gap-3 text-body-sm text-standard">
            <p className="m-0">{error}</p>
            <div>
              <Button type="button" onClick={bindings.retry}>
                Retry saving shortcuts
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function MessageKeyPreference({
  title,
  label,
  description,
  preference,
}: {
  title: string;
  label: string;
  description: string;
  preference: typeof sendKeyPreference;
}) {
  const checked = preference.usePreference();
  const [error, setError] = useState<string | null>(null);
  const change = (enabled: boolean) => setError(preference.set(enabled));
  return (
    <section>
      <InlineHeader title={title} />
      <SettingsGroup>
        <SwitchPreferenceRow
          label={label}
          description={description}
          checked={checked}
          onCheckedChange={change}
        />
      </SettingsGroup>
      {error && (
        <div role="alert" className="grid gap-3 text-body-sm text-standard">
          <p className="m-0">{error}</p>
          <div>
            <Button type="button" onClick={() => change(checked)}>
              Retry saving
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Memoized with stable callbacks: filtering renders only rows it shows. */
const ShortcutRow = memo(function ShortcutRow({
  row,
  explained,
  apple,
  sharedWith,
  listening,
  notice,
  onStart,
  onCancel,
  onCapture,
  onReset,
}: {
  row: Row;
  /** Its section already says why read-only rows can't change. */
  explained: boolean;
  apple: boolean;
  /** Other listed shortcuts whose effective chord this row also answers to. */
  sharedWith: readonly Row[];
  listening: boolean;
  notice: Notice | null;
  onStart: (row: Row) => void;
  onCancel: (row: Row) => void;
  onCapture: (row: Row, chord: CapturedChord) => void;
  onReset: (row: Row) => void;
}) {
  const titleId = useId();
  const noticeId = useId();
  const change = useRef<HTMLButtonElement>(null);
  const wasListening = useRef(listening);
  const resetting = useRef(false);
  // Return focus to the row's action when the capture control or the Reset
  // button goes away without the person having moved focus somewhere else.
  useEffect(() => {
    const stopped = wasListening.current && !listening;
    wasListening.current = listening;
    if (
      (stopped || (resetting.current && !row.override)) &&
      document.activeElement === document.body
    )
      change.current?.focus();
    resetting.current = false;
  }, [listening, row.override]);
  return (
    <article aria-labelledby={titleId}>
      <PreferenceRow
        title={
          <h4 id={titleId} className="m-0 text-label-sm">
            {row.title}
          </h4>
        }
        subtitle={
          row.readOnly ? (
            explained ? undefined : (
              "Reserved by Buzz"
            )
          ) : row.override || sharedWith.length > 0 ? (
            <>
              {row.override && <span className="block">Modified</span>}
              {sharedWith.length > 0 && (
                <span className="block text-subtle">
                  Also used by{" "}
                  {sharedWith
                    .map((other) => `${other.title} (${other.owner})`)
                    .join(", ")}
                </span>
              )}
            </>
          ) : undefined
        }
        trailing={
          <>
            {listening ? (
              <KeyCaptureControl
                apple={apple}
                label={`New shortcut for ${row.title}`}
                describedBy={notice ? noticeId : undefined}
                onCapture={(chord) => onCapture(row, chord)}
                onCancel={() => onCancel(row)}
              />
            ) : (
              <ShortcutChords chords={row.effective} apple={apple} />
            )}
            {!row.readOnly && (
              <IconButton
                variant="ghost"
                icon={
                  listening ? (
                    <XIcon size={16} aria-hidden="true" />
                  ) : (
                    <PencilSimpleIcon size={16} aria-hidden="true" />
                  )
                }
                title={listening ? "Cancel" : "Change shortcut"}
                ref={change}
                type="button"
                size="sm"
                aria-label={
                  listening
                    ? `Cancel changing ${row.title}`
                    : `Change shortcut for ${row.title}`
                }
                // Keep focus on the listening control so a click here cancels once.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => (listening ? onCancel : onStart)(row)}
              />
            )}
            {row.override && !listening && (
              <Button
                type="button"
                size="sm"
                aria-label={`Reset shortcut for ${row.title}`}
                onClick={() => {
                  resetting.current = true;
                  onReset(row);
                }}
              >
                Reset
              </Button>
            )}
          </>
        }
      />
      {notice && (
        <p
          id={noticeId}
          role="alert"
          className="m-0 text-body-sm text-standard"
        >
          {notice.message}
        </p>
      )}
    </article>
  );
});

/**
 * Text search, or a recorded chord. Recording reuses KeyCaptureControl, which
 * consumes the key so its shortcut never fires; Escape there cancels
 * recording. The section clears the search on Escape.
 */
function ShortcutSearchBar({
  search,
  apple,
  inputRef,
  onSearch,
}: {
  search: ShortcutSearch;
  apple: boolean;
  inputRef: { current: HTMLElement | null };
  onSearch: (search: ShortcutSearch) => void;
}) {
  const [recording, setRecording] = useState(false);
  const wasRecording = useRef(false);
  const value =
    search.kind === "keys"
      ? formatBinding(search.chord, apple).text
      : search.text;
  // After recording, typing or Escape continues in the search field, unless
  // the person moved focus elsewhere.
  useEffect(() => {
    const stopped = wasRecording.current && !recording;
    wasRecording.current = recording;
    if (stopped && document.activeElement === document.body)
      inputRef.current?.focus();
  }, [recording, inputRef]);
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        {recording ? (
          <KeyCaptureControl
            apple={apple}
            layout="field"
            label="Keys to search for"
            onCapture={({ binding, code }) => {
              setRecording(false);
              onSearch({ kind: "keys", chord: binding, code });
            }}
            onCancel={() => setRecording(false)}
          />
        ) : (
          <SearchField
            inputRef={inputRef}
            label="Search shortcuts"
            placeholder={`Search by name or keys, like ${apple ? "⌘K" : "Ctrl+K"}`}
            value={value}
            onValueChange={(text) => onSearch({ kind: "text", text })}
          />
        )}
      </div>
      <IconButton
        variant="ghost"
        size="sm"
        type="button"
        icon={
          recording ? (
            <XIcon size={16} aria-hidden="true" />
          ) : (
            <KeyboardIcon size={16} aria-hidden="true" />
          )
        }
        title={recording ? "Cancel" : "Search by keys"}
        aria-label={recording ? "Cancel searching by keys" : "Search by keys"}
        // Keep focus on the listening control so a click here cancels once.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setRecording(!recording)}
      />
    </div>
  );
}

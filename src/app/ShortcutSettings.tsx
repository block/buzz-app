import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "../shared/design-system/ui/Button";
import { NavigationSection } from "../shared/design-system/ui/NavigationSection";
import { SearchField } from "../shared/design-system/ui/SearchField";
import { sameBinding, type KeyBinding } from "../features/shortcuts/bindings";
import { formatBinding, isApplePlatform } from "../features/shortcuts/format";
import { KeyCombo } from "../features/shortcuts/KeyCombo";
import {
  KeyCaptureControl,
  type CapturedChord,
} from "../features/shortcuts/KeyCaptureControl";
import type { ShortcutBindings } from "../features/shortcuts/preferences";
import type { Shortcut, ShortcutsService } from "../features/shortcuts/service";
import type { PluginManager } from "../plugins/manager";

type Row = Readonly<{
  key: string;
  title: string;
  owner: string;
  defaults: readonly KeyBinding[];
  override: KeyBinding | undefined;
  effective: readonly KeyBinding[];
}>;
type Group = Readonly<{ id: string; label: string; rows: readonly Row[] }>;
type Notice = Readonly<{
  key: string;
  tone: "error" | "warning";
  message: string;
}>;

/** Chords the message editor handles locally before the window dispatcher. */
const EDITOR_CHORDS: readonly KeyBinding[] = [
  { key: "z", mod: true },
  { key: "z", mod: true, shift: true },
  { key: "y", mod: true },
  { key: "Home", mod: true },
  { key: "End", mod: true },
];
const bindingsOf = (shortcut: Shortcut): readonly KeyBinding[] =>
  "key" in shortcut.binding ? [shortcut.binding] : shortcut.binding;
const byTitle = (a: Row, b: Row) =>
  a.title.localeCompare(b.title) || a.key.localeCompare(b.key);

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
}: {
  shortcuts: ShortcutsService;
  bindings: ShortcutBindings;
  /** Display names for plugin groups come from the catalog. */
  plugins: Pick<PluginManager, "subscribe" | "snapshot">;
  apple?: boolean;
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
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const pluginName = (id: string) =>
    (configuration.status === "ready"
      ? configuration.catalog.plugins.find(
          (plugin) => plugin.manifest.id === id,
        )?.manifest.name
      : undefined) ?? id;
  const row = (key: string, shortcut: Shortcut, owner: string): Row => {
    const defaults = bindingsOf(shortcut);
    const override = overrides[key];
    return {
      key,
      title: shortcut.title,
      owner,
      defaults,
      override,
      effective: override ? [override] : defaults,
    };
  };
  const groups: Group[] = [
    {
      id: "buzz",
      label: "Buzz",
      rows: host.map((shortcut) => row(shortcut.id, shortcut, "Buzz")),
    },
    ...[...new Set(contributed.map((shortcut) => shortcut.pluginId))]
      .map((pluginId) => {
        const label = pluginName(pluginId);
        return {
          id: pluginId,
          label,
          rows: contributed
            .filter((shortcut) => shortcut.pluginId === pluginId)
            .map((shortcut) => row(shortcut.key, shortcut, label)),
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label)),
  ]
    .map((group) => ({ ...group, rows: [...group.rows].sort(byTitle) }))
    .filter((group) => group.rows.length);
  const rows = groups.flatMap((group) => group.rows);
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? groups
        .map((group) => ({
          ...group,
          rows: group.rows.filter((row) =>
            [
              row.title,
              row.owner,
              ...row.effective.flatMap((binding) => {
                const { text, label } = formatBinding(binding, apple);
                return [text, label];
              }),
            ].some((text) => text.toLowerCase().includes(needle)),
          ),
        }))
        .filter((group) => group.rows.length)
    : groups;
  const modified = Object.keys(overrides).length > 0;

  const start = (key: string) => {
    setEditing(key);
    setNotice(null);
  };
  const cancel = (key: string) => {
    setEditing((current) => (current === key ? null : current));
    setNotice((current) =>
      current?.key === key && current.tone === "error" ? null : current,
    );
  };
  // Conflicts are decided here, not in the dispatcher: host chords always win
  // there, and plugin ties resolve by sorted key, neither of which is a choice.
  const capture = (target: Row, { binding, otherPrimary }: CapturedChord) => {
    const chord = formatBinding(binding, apple).text;
    const refuse = (message: string) =>
      setNotice({ key: target.key, tone: "error", message });
    if (otherPrimary)
      return refuse(
        apple
          ? "Control isn’t used for shortcuts on this device. Try Command or Option."
          : "The Windows/Command key isn’t used for shortcuts on this device. Try Control or Alt.",
      );
    if (!binding.mod && !binding.alt)
      return refuse(
        `Include ${apple ? "Command or Option" : "Control or Alt"} so ordinary typing keeps working.`,
      );
    if (binding.key === "Dead" || binding.key === "Unidentified")
      return refuse("That key can’t be used for a shortcut. Try another.");
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
    bindings.set(target.key, isDefault ? null : binding);
    setEditing(null);
    setNotice(
      EDITOR_CHORDS.some((current) => sameBinding(current, binding))
        ? {
            key: target.key,
            tone: "warning",
            message: `Saved. The message editor handles ${chord} itself while you are typing, so it wins there.`,
          }
        : null,
    );
  };

  return (
    <section aria-labelledby="shortcut-settings-title">
      <h2 id="shortcut-settings-title" className="mt-0 mb-6 text-label">
        Shortcuts
      </h2>
      <div className="grid gap-5">
        <p className="m-0 text-body-sm text-subtle">
          Every shortcut from Buzz and your enabled plugins. Choose Change, then
          press the new keys; Escape cancels. Saved on this device.
        </p>
        <SearchField
          value={query}
          onValueChange={setQuery}
          label="Search shortcuts"
          placeholder="Search shortcuts"
        />
        {visible.length ? (
          <div>
            {visible.map((group) => (
              <NavigationSection key={group.id} label={group.label}>
                <div className="divide-y divide-line">
                  {group.rows.map((row) => (
                    <ShortcutRow
                      key={row.key}
                      row={row}
                      apple={apple}
                      listening={editing === row.key}
                      notice={notice?.key === row.key ? notice : null}
                      onStart={() => start(row.key)}
                      onCancel={() => cancel(row.key)}
                      onCapture={(chord) => capture(row, chord)}
                      onReset={() => {
                        cancel(row.key);
                        setNotice(null);
                        bindings.set(row.key, null);
                      }}
                    />
                  ))}
                </div>
              </NavigationSection>
            ))}
          </div>
        ) : (
          <p className="m-0 px-control-inset text-body-sm text-subtle">
            {rows.length
              ? "No matching shortcuts."
              : "No shortcuts are available yet."}
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
          <div role="alert" className="grid gap-3 text-body-sm text-danger">
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

function ShortcutRow({
  row,
  apple,
  listening,
  notice,
  onStart,
  onCancel,
  onCapture,
  onReset,
}: {
  row: Row;
  apple: boolean;
  listening: boolean;
  notice: Notice | null;
  onStart: () => void;
  onCancel: () => void;
  onCapture: (chord: CapturedChord) => void;
  onReset: () => void;
}) {
  const titleId = useId();
  const noticeId = useId();
  const change = useRef<HTMLButtonElement>(null);
  const wasListening = useRef(listening);
  // Return focus to the row's action when the capture control goes away
  // without the person having moved focus somewhere else.
  useEffect(() => {
    if (
      wasListening.current &&
      !listening &&
      document.activeElement === document.body
    )
      change.current?.focus();
    wasListening.current = listening;
  }, [listening]);
  const primary = row.effective[0];
  return (
    <article
      className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
      aria-labelledby={titleId}
    >
      <div className="min-w-0 flex-1">
        <h3 id={titleId} className="m-0 text-label font-medium">
          {row.title}
        </h3>
        {row.override && (
          <p className="m-0 text-body-sm text-subtle">Modified</p>
        )}
        {notice && (
          <p
            id={noticeId}
            role="alert"
            className={`m-0 text-body-sm ${notice.tone === "error" ? "text-danger" : "text-warning"}`}
          >
            {notice.message}
          </p>
        )}
      </div>
      <div className="actions items-center">
        {listening ? (
          <KeyCaptureControl
            apple={apple}
            label={`New shortcut for ${row.title}`}
            describedBy={notice ? noticeId : undefined}
            onCapture={onCapture}
            onCancel={onCancel}
          />
        ) : (
          primary && <KeyCombo binding={primary} apple={apple} />
        )}
        <Button
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
          onClick={listening ? onCancel : onStart}
        >
          {listening ? "Cancel" : "Change"}
        </Button>
        {row.override && !listening && (
          <Button
            type="button"
            size="sm"
            aria-label={`Reset shortcut for ${row.title}`}
            onClick={onReset}
          >
            Reset
          </Button>
        )}
      </div>
    </article>
  );
}

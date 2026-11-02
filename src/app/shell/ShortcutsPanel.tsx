import { useEffect, useRef, useState } from "react";
import { isApplePlatform } from "../../features/shortcuts/format";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { HOST_SHORTCUT_ORDER } from "../shortcuts";
import { ShortcutChords, useShortcutGroups } from "../ShortcutSettings";
import type { SearchServices } from "./PageSearch";

/**
 * ⌘/ opens a read-only list of every shortcut, as Slack's does, from the same
 * groups Settings → Shortcuts shows, so rebinds and plugin keys appear as they
 * are. Changing a key stays in Settings, one click away.
 */
export function ShortcutsPanel({
  services,
}: {
  services: SearchServices & Required<Pick<SearchServices, "plugins">>;
}) {
  const { shortcuts, navigation } = services;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLElement>(null);
  useEffect(
    () =>
      shortcuts.registerHost({
        id: "show-shortcuts",
        title: "Show keyboard shortcuts",
        order: HOST_SHORTCUT_ORDER.shortcuts,
        binding: { key: "/", mod: true },
        allowInEditable: true,
        run: () => {
          setQuery("");
          setOpen(true);
        },
      }),
    [shortcuts],
  );
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Keyboard shortcuts"
      size="wide"
      height="stable-tall"
      initialFocus={search}
      actions={
        <Button
          type="button"
          onClick={() => {
            setOpen(false);
            void navigation.open({
              version: 1,
              kind: "settings",
              section: "shortcuts",
            });
          }}
        >
          Change shortcuts in Settings
        </Button>
      }
    >
      <div className="grid gap-section-gap">
        <SearchField
          label="Search shortcuts"
          placeholder="Search shortcuts"
          value={query}
          onValueChange={setQuery}
          inputRef={search}
        />
        {/* Mounted only while open, so the closed panel doesn't follow every
            shortcut and plugin change. */}
        {open && <ShortcutList services={services} query={query} />}
      </div>
    </Dialog>
  );
}

function ShortcutList({
  services: { shortcuts, shortcutBindings, plugins },
  query,
}: {
  services: SearchServices & Required<Pick<SearchServices, "plugins">>;
  query: string;
}) {
  const apple = isApplePlatform(navigator.platform);
  const { shownGroups } = useShortcutGroups({
    shortcuts,
    bindings: shortcutBindings,
    plugins,
  });
  const needle = query.trim().toLowerCase();
  const groups = shownGroups
    .map((group) => ({
      ...group,
      rows: needle
        ? group.rows.filter((row) =>
            `${row.title} ${group.label}`.toLowerCase().includes(needle),
          )
        : group.rows,
    }))
    .filter((group) => group.rows.length);
  return groups.length ? (
    <>
      {groups.map((group) => (
        <section key={group.id}>
          <InlineHeader title={group.label} subtitle={group.description} />
          <SettingsGroup>
            {group.rows.map((row) => (
              <PreferenceRow
                key={row.key}
                title={row.title}
                trailing={
                  <ShortcutChords chords={row.effective} apple={apple} />
                }
              />
            ))}
          </SettingsGroup>
        </section>
      ))}
    </>
  ) : (
    <p className="m-0 px-control-inset text-body-sm text-subtle">
      No shortcuts match “{query.trim()}”.
    </p>
  );
}

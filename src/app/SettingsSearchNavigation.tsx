import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { matches } from "../features/shortcuts/bindings";
import { isApplePlatform } from "../features/shortcuts/format";
import type {
  ShortcutBindings,
  ShortcutBindingsSnapshot,
} from "../features/shortcuts/preferences";
import {
  CONVERSATION_SEARCH_BINDING,
  CONVERSATION_SEARCH_ID,
} from "./shell/PageSearch";
import { activeModal } from "../shared/design-system/overlayLayer";
import { SearchField } from "../shared/design-system/ui/SearchField";
import { NavigationItem } from "../shared/design-system/ui/NavigationItem";
import { NavigationSection } from "../shared/design-system/ui/NavigationSection";
import { SidebarNavigation } from "../shared/design-system/ui/SidebarNavigation";
import type { SettingsGroup } from "./settings-sections";
import { searchSettings, type SettingSearchEntry } from "./settings-search";

const NO_OVERRIDES: ShortcutBindingsSnapshot = { overrides: {}, error: null };
const noSubscribe = () => () => {};
const noOverrides = () => NO_OVERRIDES;

/** Both Settings hosts keep their existing navigation and scroll ownership. */
export function SettingsSearchNavigation({
  groups,
  children,
  onSection,
  onSetting,
  shortcutBindings,
}: {
  groups: readonly SettingsGroup[];
  /** The person's rebinds; without them the default chord applies. */
  shortcutBindings?: ShortcutBindings | undefined;
  children: ReactNode;
  onSection: (section: string) => void;
  onSetting: (setting: SettingSearchEntry) => void;
}) {
  const [query, setQuery] = useState("");
  const searching = !!query.trim();
  const results = searchSettings(groups, query);
  const field = useRef<HTMLElement>(null);
  const { overrides } = useSyncExternalStore(
    shortcutBindings?.subscribe ?? noSubscribe,
    shortcutBindings?.snapshot ?? noOverrides,
  );
  const binding =
    overrides[CONVERSATION_SEARCH_ID] ?? CONVERSATION_SEARCH_BINDING;
  // The conversation search chord (⌘F / Ctrl+F unless rebound) finds within
  // Settings. Settings' modal leaves the conversation shortcut ineligible,
  // and handling it before the window dispatcher keeps it local.
  useEffect(() => {
    const find = (event: KeyboardEvent) => {
      const input = field.current;
      const modal = activeModal(document);
      if (
        event.defaultPrevented ||
        event.isComposing ||
        !input?.isConnected ||
        (modal && !modal.contains(input)) ||
        input.closest("[hidden], [inert]") ||
        !matches([binding], event, isApplePlatform(navigator.platform))
      )
        return;
      event.preventDefault();
      input.focus();
      if (input instanceof HTMLInputElement) input.select();
    };
    document.addEventListener("keydown", find);
    return () => document.removeEventListener("keydown", find);
  }, [binding]);
  return (
    <SidebarNavigation wrapSections>
      <div className="w-full min-w-0">
        <SearchField
          inputRef={field}
          label="Search settings"
          placeholder="Search settings…"
          value={query}
          onValueChange={setQuery}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            }
          }}
        />
      </div>
      {searching ? (
        <>
          <p role="status" className="m-0 w-full text-body-sm text-subtle">
            {results.length
              ? `${results.length} ${results.length === 1 ? "result" : "results"}`
              : "No settings found. Try another search."}
          </p>
          {groups.flatMap((group) =>
            group.sections.map((section) => {
              const matches = results.filter(
                (result) => result.section === section.id,
              );
              if (!matches.length) return null;
              return (
                <NavigationSection key={section.id} label={section.label}>
                  {matches.map((result) => (
                    <NavigationItem
                      key={result.setting?.id ?? section.id}
                      multiline
                      label={
                        <>
                          <span className="block">
                            {result.setting?.label ?? `Open ${result.label}`}
                          </span>
                          {result.setting?.hint && (
                            <span className="block text-caption text-subtle">
                              {result.setting.hint}
                            </span>
                          )}
                        </>
                      }
                      onClick={() =>
                        result.setting
                          ? onSetting(result.setting)
                          : onSection(section.id)
                      }
                    />
                  ))}
                </NavigationSection>
              );
            }),
          )}
        </>
      ) : (
        children
      )}
    </SidebarNavigation>
  );
}

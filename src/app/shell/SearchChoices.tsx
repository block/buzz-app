import {
  useEffect,
  useId,
  useState,
  type RefObject,
  type ReactNode,
} from "react";
import type { ChatCircleIcon } from "../../shared/design-system/icons/index";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { NavigationSection } from "../../shared/design-system/ui/NavigationSection";
import { SearchField } from "../../shared/design-system/ui/SearchField";

export type SearchDestination = {
  key: string;
  label: string;
  detail?: string;
  icon: typeof ChatCircleIcon;
  run: () => void;
};

export type SearchInputProps = {
  query: string;
  onQueryChange: (query: string) => void;
  input: RefObject<HTMLElement | null>;
};

export function SearchChoices({
  groups,
  query,
  onQueryChange,
  input,
  children,
}: SearchInputProps & {
  groups: readonly {
    label: string;
    destinations: readonly SearchDestination[];
  }[];
  children?: ReactNode;
}) {
  const id = useId();
  const destinations = groups.flatMap((group) => group.destinations);
  // Follow a destination's identity, not its index, as relay results arrive.
  // Clear removed choices immediately so a later reappearance cannot reactivate one.
  const [selection, setSelection] = useState({ query, key: "" });
  const valid =
    selection.query === query &&
    destinations.some(({ key }) => key === selection.key);
  if (selection.query !== query || (selection.key && !valid))
    setSelection({ query, key: "" });
  const selected = valid ? selection.key : "";
  const optionId = (key: string) => `${id}-${key}`;
  useEffect(() => {
    input.current?.focus();
  }, [input]);
  useEffect(() => {
    if (selected)
      document
        .getElementById(`${id}-${selected}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [selected, id]);
  return (
    <>
      <SearchField
        inputRef={input}
        role="combobox"
        aria-controls={id}
        aria-expanded="true"
        aria-autocomplete="list"
        aria-activedescendant={selected ? optionId(selected) : undefined}
        label="Search Buzz"
        placeholder="Search pages, conversations and messages…"
        value={query}
        onValueChange={onQueryChange}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        maxLength={256}
        onKeyDown={(event) => {
          if (
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229 ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey
          )
            return;
          const index = destinations.findIndex(({ key }) => key === selected);
          if (event.key === "Enter" && index >= 0) {
            event.preventDefault();
            destinations[index]?.run();
          } else if (
            (event.key === "ArrowDown" || event.key === "ArrowUp") &&
            destinations.length
          ) {
            event.preventDefault();
            const next =
              index < 0
                ? event.key === "ArrowDown"
                  ? 0
                  : destinations.length - 1
                : Math.max(
                    0,
                    Math.min(
                      destinations.length - 1,
                      index + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                  );
            setSelection({ query, key: destinations[next]?.key ?? "" });
          }
        }}
      />
      <div className="-mx-5 mt-2 max-h-[55vh] space-y-3 overflow-y-auto px-1 py-1 max-[480px]:-mx-3">
        <div
          id={id}
          role="listbox"
          aria-label="Search results"
          className="space-y-3"
        >
          {groups.map(
            ({ label, destinations }) =>
              destinations.length > 0 && (
                // biome-ignore lint/a11y/useSemanticElements: A listbox option group is not a form fieldset.
                <div key={label} role="group" aria-label={label}>
                  <NavigationSection label={label}>
                    {destinations.map(
                      ({ key, label, detail, icon: Icon, run }) => (
                        <NavigationItem
                          key={key}
                          id={optionId(key)}
                          role="option"
                          tabIndex={-1}
                          aria-selected={selected === key}
                          aria-current={false}
                          selected={selected === key}
                          data-search-result=""
                          icon={
                            <span className="grid size-6 shrink-0 place-items-center">
                              <Icon size={17} aria-hidden="true" />
                            </span>
                          }
                          label={
                            <>
                              <span className="block truncate text-body-sm">
                                {label}
                              </span>
                              {detail && (
                                <span className="block truncate text-caption text-subtle">
                                  {detail}
                                </span>
                              )}
                            </>
                          }
                          onClick={run}
                        />
                      ),
                    )}
                  </NavigationSection>
                </div>
              ),
          )}
        </div>
        {!destinations.length && (
          <p className="px-control-inset text-body-sm text-subtle">
            No matching destinations.
          </p>
        )}
        {children && <div className="px-control-inset">{children}</div>}
      </div>
      <p className="mt-3 text-caption text-metadata">
        ↑ ↓ to move · Enter to open · Esc to close
      </p>
    </>
  );
}

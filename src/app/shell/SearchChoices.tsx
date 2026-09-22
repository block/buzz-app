import type { KeyboardEvent } from "react";
import type { ChatCircleIcon } from "../../shared/design-system/icons/index";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { NavigationSection } from "../../shared/design-system/ui/NavigationSection";

export type SearchDestination = {
  key: string;
  label: string;
  detail?: string;
  icon: typeof ChatCircleIcon;
  run: () => void;
};

/** Native buttons retain Tab/Enter semantics; arrows also move through results. */
export function searchKeys(event: KeyboardEvent<HTMLElement>) {
  if (
    event.nativeEvent.isComposing ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  )
    return;
  const results = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      "[data-search-result]",
    ),
  ];
  const index = results.indexOf(event.target as HTMLButtonElement);
  const inSearch = (event.target as HTMLElement).matches(
    'input[type="search"]',
  );
  if (inSearch && event.key === "Enter" && results.length) {
    event.preventDefault();
    results[0]?.click();
  } else if (
    (inSearch || index >= 0) &&
    (event.key === "ArrowDown" || event.key === "ArrowUp") &&
    results.length
  ) {
    event.preventDefault();
    const next = inSearch
      ? event.key === "ArrowDown"
        ? 0
        : results.length - 1
      : index + (event.key === "ArrowDown" ? 1 : -1);
    if (next < 0 || next >= results.length)
      event.currentTarget
        .querySelector<HTMLInputElement>('input[type="search"]')
        ?.focus();
    else {
      results[next]?.focus();
      results[next]?.scrollIntoView({ block: "nearest" });
    }
  }
}

export function SearchChoices({
  groups,
}: {
  groups: readonly {
    label: string;
    destinations: readonly SearchDestination[];
  }[];
}) {
  return (
    <nav aria-label="Search results" className="space-y-3">
      {groups.every((group) => !group.destinations.length) && (
        <p className="px-3 text-body-sm text-subtle">
          No matching destinations.
        </p>
      )}
      {groups.map(
        ({ label, destinations }) =>
          destinations.length > 0 && (
            <NavigationSection key={label} label={label}>
              {destinations.map(({ key, label, detail, icon: Icon, run }) => (
                <NavigationItem
                  key={key}
                  data-search-result=""
                  icon={<Icon size={17} aria-hidden="true" />}
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
              ))}
            </NavigationSection>
          ),
      )}
    </nav>
  );
}

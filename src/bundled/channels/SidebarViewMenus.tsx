import type { SidebarSortMode } from "../../features/relay/sidebar-sort";
import {
  ArrowsDownUpIcon,
  Filter2Icon,
  ListBulletsIcon,
  SquaresFourIcon,
} from "../../shared/design-system/icons";
import {
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuIcon,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
} from "../../shared/design-system/ui/Menu";

export type SidebarViewSort = {
  value: SidebarSortMode;
  modes?: readonly { id: SidebarSortMode; label: string }[];
  change: (mode: SidebarSortMode) => void;
};

/** Preset windows for "active in the last N days". */
export const SIDEBAR_FILTER_DAYS = [1, 3, 7, 30] as const;

export type SidebarViewFilter = {
  /** Days a conversation must have been active within; undefined shows all. */
  days: number | undefined;
  disabled?: boolean | undefined;
  /** Saves the choice; a rejection means it wasn't saved. */
  change: (days: number | undefined) => unknown;
  dismissError?: (() => void) | undefined;
};

const daysLabel = (days: number) => `${days} ${days === 1 ? "day" : "days"}`;

/**
 * A card's view choices in its ••• menu: the Sort and Filter submenus, then
 * Layout at the top level since it doesn't sort.
 */
export function SidebarViewMenuItems({
  title,
  sort,
  unreadsFirst,
  filter,
  customFilter,
  display,
  layout,
}: {
  title: string;
  sort?: SidebarViewSort | undefined;
  unreadsFirst?: { on: boolean; set: (on: boolean) => void } | undefined;
  filter?: SidebarViewFilter | undefined;
  /** Opens the custom window dialog. */
  customFilter?: (() => void) | undefined;
  display?:
    | { value: "list" | "icons"; set: (value: "list" | "icons") => void }
    | undefined;
  /** A card's own layouts, when it offers them instead of list or icons. */
  layout?:
    | {
        value: string;
        options: readonly { id: string; label: string }[];
        set: (value: string) => void;
      }
    | undefined;
}) {
  if (!sort && !unreadsFirst && !filter && !display && !layout) return null;
  const preset =
    filter?.days === undefined ||
    (SIDEBAR_FILTER_DAYS as readonly number[]).includes(filter.days);
  const filterValue =
    filter?.days === undefined
      ? "all"
      : preset
        ? String(filter.days)
        : "custom";
  return (
    <>
      {(sort || unreadsFirst) && (
        <MenuSubmenu>
          <MenuSubmenuTrigger>
            <MenuIcon>
              <ArrowsDownUpIcon size={14} />
            </MenuIcon>
            Sort
          </MenuSubmenuTrigger>
          <MenuSubmenuPopup aria-label={`Sort ${title}`} finalFocus={false}>
            {sort && (
              <MenuRadioGroup
                value={sort.value}
                onValueChange={(mode) => sort.change(mode as SidebarSortMode)}
              >
                <MenuRadioItem value="recent" selection="highlight">
                  Recent
                </MenuRadioItem>
                <MenuRadioItem value="alpha" selection="highlight">
                  A–Z
                </MenuRadioItem>
                {/* Only when a plugin contributes its own order. */}
                {sort.modes?.map((mode) => (
                  <MenuRadioItem
                    key={mode.id}
                    value={mode.id}
                    selection="highlight"
                  >
                    {mode.label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            )}
            {sort && unreadsFirst && <MenuSeparator />}
            {unreadsFirst && (
              <MenuCheckboxItem
                checked={unreadsFirst.on}
                onCheckedChange={unreadsFirst.set}
              >
                Unreads first
              </MenuCheckboxItem>
            )}
          </MenuSubmenuPopup>
        </MenuSubmenu>
      )}
      {filter && (
        <MenuSubmenu>
          <MenuSubmenuTrigger>
            <MenuIcon>
              <Filter2Icon size={14} />
            </MenuIcon>
            Filter
          </MenuSubmenuTrigger>
          <MenuSubmenuPopup aria-label={`Filter ${title}`} finalFocus={false}>
            <MenuRadioGroup
              value={filterValue}
              onValueChange={(value) => {
                // Custom opens its dialog from the item's click instead.
                if (value === "custom") return;
                void Promise.resolve(
                  filter.change(value === "all" ? undefined : Number(value)),
                ).catch(() => {});
              }}
            >
              <MenuRadioItem
                value="all"
                selection="highlight"
                disabled={filter.disabled}
              >
                All
              </MenuRadioItem>
              {SIDEBAR_FILTER_DAYS.map((days) => (
                <MenuRadioItem
                  key={days}
                  value={String(days)}
                  selection="highlight"
                  disabled={filter.disabled}
                >
                  {daysLabel(days)}
                </MenuRadioItem>
              ))}
              {customFilter && (
                <MenuRadioItem
                  value="custom"
                  selection="highlight"
                  disabled={filter.disabled}
                  onClick={customFilter}
                >
                  {preset || filter.days === undefined
                    ? "Custom…"
                    : `Custom (${daysLabel(filter.days)})`}
                </MenuRadioItem>
              )}
            </MenuRadioGroup>
          </MenuSubmenuPopup>
        </MenuSubmenu>
      )}
      {display && (
        <>
          {(sort || unreadsFirst || filter) && <MenuSeparator />}
          <MenuGroup>
            <MenuGroupLabel emphasis="quiet">Layout</MenuGroupLabel>
            <MenuRadioGroup
              value={display.value}
              onValueChange={(value) =>
                display.set(value === "icons" ? "icons" : "list")
              }
            >
              <MenuRadioItem value="list" selection="highlight">
                <MenuIcon>
                  <ListBulletsIcon size={14} />
                </MenuIcon>
                List
              </MenuRadioItem>
              <MenuRadioItem value="icons" selection="highlight">
                <MenuIcon>
                  <SquaresFourIcon size={14} />
                </MenuIcon>
                Icons
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        </>
      )}
      {layout && (
        <>
          {(sort || unreadsFirst || filter || display) && <MenuSeparator />}
          <MenuGroup>
            <MenuGroupLabel emphasis="quiet">Layout</MenuGroupLabel>
            <MenuRadioGroup value={layout.value} onValueChange={layout.set}>
              {layout.options.map((option) => (
                <MenuRadioItem
                  key={option.id}
                  value={option.id}
                  selection="highlight"
                >
                  {option.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </>
      )}
    </>
  );
}

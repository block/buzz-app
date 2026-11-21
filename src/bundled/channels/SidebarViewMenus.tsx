import type { SidebarSortMode } from "../../features/relay/sidebar-sort";
import {
  ArrowsDownUpIcon,
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

/**
 * A card's view choices in its ••• menu: the Sort submenu, then Layout at the
 * top level since it doesn't sort.
 */
export function SidebarViewMenuItems({
  title,
  sort,
  unreadsFirst,
  display,
}: {
  title: string;
  sort?: SidebarViewSort | undefined;
  unreadsFirst?: { on: boolean; set: (on: boolean) => void } | undefined;
  display?:
    | { value: "list" | "icons"; set: (value: "list" | "icons") => void }
    | undefined;
}) {
  if (!sort && !unreadsFirst && !display) return null;
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
      {display && (
        <>
          {(sort || unreadsFirst) && <MenuSeparator />}
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
    </>
  );
}

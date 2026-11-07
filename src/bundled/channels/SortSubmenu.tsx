import {
  MenuIcon,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
} from "../../shared/design-system/ui/Menu";
import {
  ArrowsDownUpIcon,
  TextAaIcon,
  TimerIcon,
} from "../../shared/design-system/icons";
import type { SidebarSortMode } from "../../features/relay/sidebar-sort";

/** The Sort choices every sidebar section menu offers, plus plugin modes. */
export function SortSubmenu({
  title,
  value,
  modes,
  onChange,
  closeOnClick = false,
}: {
  title: string;
  value: SidebarSortMode;
  modes?: readonly { id: SidebarSortMode; label: string }[] | undefined;
  onChange: (mode: SidebarSortMode) => void;
  closeOnClick?: boolean;
}) {
  return (
    <MenuSubmenu>
      <MenuSubmenuTrigger>
        <MenuIcon>
          <ArrowsDownUpIcon size={14} />
        </MenuIcon>
        Sort
      </MenuSubmenuTrigger>
      <MenuSubmenuPopup aria-label={`Sort ${title}`} finalFocus={false}>
        <MenuRadioGroup
          value={value}
          onValueChange={(mode) => onChange(mode as SidebarSortMode)}
        >
          <MenuRadioItem closeOnClick={closeOnClick} value="recent">
            <MenuIcon>
              <TimerIcon size={14} />
            </MenuIcon>
            Recent
          </MenuRadioItem>
          <MenuRadioItem closeOnClick={closeOnClick} value="alpha">
            <MenuIcon>
              <TextAaIcon size={14} />
            </MenuIcon>
            A–Z
          </MenuRadioItem>
          {modes?.map((mode) => (
            <MenuRadioItem
              key={mode.id}
              closeOnClick={closeOnClick}
              value={mode.id}
            >
              <MenuIcon>{null}</MenuIcon>
              {mode.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSubmenuPopup>
    </MenuSubmenu>
  );
}

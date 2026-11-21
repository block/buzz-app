import { useSyncExternalStore } from "react";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRoot,
} from "../../shared/design-system/ui/Menu";
import type { Pending } from "./pending";
import { WHICH_KEY } from "./pending";
import {
  keyLabel,
  sequenceChoices,
  type Sequence,
  type SequenceGroup,
} from "./sequences";

/** Centred above the bottom of the app's content, like Neovim's which-key. */
const anchor = {
  getBoundingClientRect() {
    const frame = (
      document.getElementById("main-content") ?? document.documentElement
    ).getBoundingClientRect();
    return DOMRect.fromRect({
      x: frame.left + frame.width / 2,
      y: Math.min(frame.bottom, innerHeight) - 16,
      width: 0,
      height: 0,
    });
  },
};

/** The keys that can follow what has been typed, each runnable by click too. */
export function WhichKey({
  pending,
  sequences,
  groups,
}: {
  pending: Pending;
  sequences: () => readonly Sequence[];
  groups: readonly SequenceGroup[];
}) {
  const state = useSyncExternalStore(pending.subscribe, pending.snapshot);
  const typed = state?.typed ?? "";
  const choices = state ? sequenceChoices(typed, sequences(), groups) : [];
  const group = groups.find(({ keys }) => keys === typed);
  const heading = [...typed].map(keyLabel).join(" ");
  return (
    <MenuRoot
      open={!!state?.shown && choices.length > 0}
      modal={false}
      onOpenChange={(open) => {
        if (!open) pending.cancel();
      }}
    >
      <MenuPopup
        anchor={anchor}
        side="top"
        align="center"
        size="compact"
        {...{ [WHICH_KEY]: "" }}
      >
        <MenuGroup>
          <MenuGroupLabel emphasis="quiet">
            {group ? `${heading} · ${group.title}` : heading}
          </MenuGroupLabel>
          {choices.map((choice) => (
            <MenuItem
              key={choice.key}
              letter={keyLabel(choice.key)}
              // A group keeps the menu open for its next key.
              closeOnClick={!choice.group}
              onClick={() => pending.press(choice.key)}
            >
              {choice.group ? `${choice.title}…` : choice.title}
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </MenuRoot>
  );
}

import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRoot,
} from "../../shared/design-system/ui/Menu";
import type { Pending } from "./pending";
import { WHICH_KEY } from "./dom";
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

type Props = {
  pending: Pending;
  sequences: readonly Sequence[];
  groups: readonly SequenceGroup[];
};

/** Show the which-key menu until the returned stop. Its own root: no host
 * surface hosts a plugin's global menu, and the shared Menu needs no host
 * provider. */
export function mountWhichKey(props: Props) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  root.render(<WhichKey {...props} />);
  return () => {
    root.unmount();
    host.remove();
  };
}

/** The keys that can follow what has been typed, each runnable by click too. */
function WhichKey({ pending, sequences, groups }: Props) {
  const state = useSyncExternalStore(pending.subscribe, pending.snapshot);
  const typed = state?.typed ?? "";
  const choices = state ? sequenceChoices(typed, sequences, groups) : [];
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
        // Focus stays where the sequence left it, else the cursor takes it
        // back; Base UI's return focus could land on another message's part.
        finalFocus={() => false}
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

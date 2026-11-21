import {
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import {
  SchematicCard,
  SchematicDropLine,
  SchematicGrip,
  SchematicPointer,
  SchematicRow,
  SchematicScene,
} from "../../shared/design-system/ui/Schematic";
import { Tour, type TourPage } from "../../shared/design-system/ui/Tour";
import { readView, subscribeView, writeView } from "../../shared/view-state";

// Remembered on this device, like the resize hint. A later sidebar release
// bumps the edition so the tour shows once more for what changed.
const seenScope = "device";
const seenKey = "sidebar:tour-seen";
export const sidebarTourEdition = "workspaces-1";

export const sidebarTourPages: readonly TourPage[] = [
  {
    id: "anything",
    title: "Workspaces hold anything",
    description: "Put chats, channels and DMs together in any workspace.",
    visual: (
      <SchematicScene>
        <SchematicCard>
          <SchematicRow lead="channel" />
          <SchematicRow lead="person" enter={1} />
          <SchematicRow lead="chat" enter={2} />
          <SchematicRow lead="channel" enter={3} />
        </SchematicCard>
      </SchematicScene>
    ),
  },
  {
    id: "resize",
    title: "Resize a workspace",
    description:
      "Drag the handle under a workspace to show more or fewer rows.",
    visual: (
      <SchematicScene>
        <SchematicCard
          visibleRows={2}
          motion="grow"
          footer={
            <SchematicGrip tone="accent">
              <SchematicPointer motion="drag" />
            </SchematicGrip>
          }
        >
          <SchematicRow lead="channel" />
          <SchematicRow lead="person" />
          <SchematicRow lead="chat" />
          <SchematicRow lead="channel" />
          <SchematicRow lead="person" />
        </SchematicCard>
      </SchematicScene>
    ),
  },
  {
    id: "show-all",
    title: "See everything at once",
    description: "Double-click the handle under a workspace to show all of it.",
    visual: (
      <SchematicScene>
        <SchematicCard
          visibleRows={2}
          motion="expand"
          footer={
            <SchematicGrip tone="accent">
              <SchematicPointer motion="double-tap" />
            </SchematicGrip>
          }
        >
          <SchematicRow lead="channel" />
          <SchematicRow lead="person" />
          <SchematicRow lead="chat" />
          <SchematicRow lead="channel" />
          <SchematicRow lead="person" />
        </SchematicCard>
      </SchematicScene>
    ),
  },
  {
    id: "reorder",
    title: "Reorder workspaces",
    description: "Drag a workspace by its header to move it.",
    visual: (
      <SchematicScene>
        <SchematicCard
          motion="lift"
          travel={3}
          header={<SchematicPointer motion="drag" />}
        >
          <SchematicRow lead="chat" tone="accent" />
        </SchematicCard>
        <SchematicCard motion="yield" travel={1} footer={<SchematicDropLine />}>
          <SchematicRow lead="channel" />
          <SchematicRow lead="person" />
        </SchematicCard>
      </SchematicScene>
    ),
  },
];

/** Introduces custom workspaces once per device, beside the sidebar. */
export function SidebarTour({
  listRef,
  ready,
}: {
  listRef: RefObject<HTMLElement | null>;
  /** Wait for the sidebar's layout so the card does not jump as it settles. */
  ready: boolean;
}) {
  const seen = useSyncExternalStore(
    (change) => subscribeView(seenScope, change),
    () => readView<unknown>(seenScope, seenKey, null) === sidebarTourEdition,
  );
  const [anchor, setAnchor] = useState<Element | null>(null);
  useLayoutEffect(() => {
    if (!ready || seen) return;
    setAnchor(listRef.current?.closest("aside") ?? null);
  }, [listRef, ready, seen]);
  if (seen || !ready || !anchor) return null;
  return (
    <Tour
      open
      label="What’s new in the sidebar"
      pages={sidebarTourPages}
      anchor={anchor}
      side="right"
      align="end"
      onDismiss={() => writeView(seenScope, seenKey, sidebarTourEdition)}
    />
  );
}

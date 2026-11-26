import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowsDownUpIcon,
  GripVerticalIcon,
  PinFilledIcon,
  PinIcon,
  CaretRightIcon,
  PuzzleIcon,
} from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  NavigationCard,
  NavigationItem,
} from "../../shared/design-system/ui/NavigationItem";
import {
  PopoverPopup,
  PopoverRoot,
  PopoverTitle,
  PopoverTrigger,
} from "../../shared/design-system/ui/Popover";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { Select } from "../../shared/design-system/ui/Select";
import type { AllPluginsEntry, AllPluginsProps } from "./all-plugins";
import styles from "./AllPlugins.module.css";

export type { AllPluginsEntry, AllPluginsProps } from "./all-plugins";

/** Search earns its place once your own plugins no longer fit at a glance. */
export const ALL_PLUGINS_SEARCH_THRESHOLD = 20;

const byLabel = (a: AllPluginsEntry, b: AllPluginsEntry) =>
  a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) ||
  a.key.localeCompare(b.key);

/** Pinned plugins lead, in the person's order; the rest follow A–Z. */
export function arrangePlugins(
  plugins: readonly AllPluginsEntry[],
  query = "",
) {
  const needle = query.trim().toLocaleLowerCase();
  const matches = needle
    ? plugins.filter((plugin) =>
        plugin.label.toLocaleLowerCase().includes(needle),
      )
    : plugins;
  return {
    pinned: matches.filter((plugin) => plugin.pinned),
    rest: matches.filter((plugin) => !plugin.pinned).sort(byLabel),
  };
}

function moveKey(keys: readonly string[], from: string, to: string) {
  if (!keys.includes(from) || !keys.includes(to)) return keys;
  const next = keys.filter((key) => key !== from);
  next.splice(keys.indexOf(to), 0, from);
  return next;
}

/** Up and Down move between plugins, as in other navigation popovers. */
function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>("[data-plugin-row]"),
  );
  if (!rows.length) return;
  const index = rows.findIndex((row) => row.contains(document.activeElement));
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? rows.length - 1
        : index < 0
          ? event.key === "ArrowDown"
            ? 0
            : rows.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) %
            rows.length;
  rows[next]?.focus();
}

/** The Plugins card's last row. Resting on it, or pressing it, opens every
 * plugin you have on, so one that isn't pinned is a step away. */
export function AllPlugins({
  plugins,
  onOpen,
  onPinnedChange,
  onPinnedOrderChange,
  sort,
  onSortChange,
}: AllPluginsProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [dragging, setDragging] = useState<string>();
  const opened = useRef(false);
  const searchable = plugins.length >= ALL_PLUGINS_SEARCH_THRESHOLD;
  const searching = searchable && query.trim() !== "";
  const { pinned, rest } = useMemo(
    () => arrangePlugins(plugins, searchable ? query : ""),
    [plugins, query, searchable],
  );
  const pinnedOrder = useMemo(
    () => plugins.filter((plugin) => plugin.pinned).map(({ key }) => key),
    [plugins],
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const reorder = useCallback(
    (from: string, to: string) => {
      const next = moveKey(pinnedOrder, from, to);
      if (next !== pinnedOrder) onPinnedOrderChange(next);
    },
    [pinnedOrder, onPinnedOrderChange],
  );
  const openPlugin = (key: string) => {
    opened.current = true;
    setOpen(false);
    onOpen(key);
  };
  const row = (plugin: AllPluginsEntry, index: number) => (
    <PluginRow
      key={plugin.key}
      plugin={plugin}
      move={
        plugin.pinned && !searching && pinned.length > 1
          ? {
              previous: pinned[index - 1]?.key,
              next: pinned[index + 1]?.key,
              reorder,
            }
          : undefined
      }
      onOpen={openPlugin}
      onPinnedChange={onPinnedChange}
    />
  );
  const draggingPlugin = plugins.find((plugin) => plugin.key === dragging);
  return (
    <PopoverRoot
      open={open}
      onOpenChange={(next) => {
        // The drag preview follows the pointer outside the popup, which reads
        // as leaving a hover-opened popover; a reorder in progress keeps it.
        if (!next && dragging) return;
        if (next) {
          opened.current = false;
          setQuery("");
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger
        openOnHover="preview"
        render={
          <NavigationItem
            label="All plugins"
            variant="row"
            icon={
              <span className="shell-page-icon">
                <PuzzleIcon size={16} strokeWidth={2.5} />
              </span>
            }
            trailing={<CaretRightIcon size={16} aria-hidden="true" />}
          />
        }
      />
      <PopoverPopup
        padding="none"
        side="right"
        align="start"
        // Opening a plugin hands focus to its page, not back to this row.
        finalFocus={() =>
          opened.current
            ? (document.getElementById("main-content") ?? false)
            : true
        }
      >
        <div className={styles.frame}>
          <div className={styles.header}>
            <PopoverTitle size="sm">Your plugins</PopoverTitle>
            <Select
              variant="compact"
              size="xs"
              align="end"
              leading={<ArrowsDownUpIcon size={16} />}
              label="Sort pinned plugins"
              value={sort}
              groups={[
                {
                  label: "Sort pinned plugins",
                  options: [
                    { value: "alphabetical", label: "A–Z" },
                    { value: "custom", label: "Custom" },
                  ],
                },
              ]}
              onValueChange={(value) =>
                onSortChange(value === "custom" ? "custom" : "alphabetical")
              }
            />
          </div>
          {searchable && (
            <div className={styles.search}>
              <SearchField
                variant="capsule"
                label="Search plugins"
                placeholder="Search plugins"
                value={query}
                onValueChange={setQuery}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowDown") return;
                  event.preventDefault();
                  event.currentTarget
                    .closest(`.${styles.frame}`)
                    ?.querySelector<HTMLElement>("[data-plugin-row]")
                    ?.focus();
                }}
              />
            </div>
          )}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move between the rows' own buttons */}
          <div className={styles.body} onKeyDown={moveFocus}>
            {pinned.length > 0 && (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                accessibility={{ container: document.body }}
                onDragStart={({ active }) => setDragging(String(active.id))}
                onDragCancel={() => setDragging(undefined)}
                onDragEnd={({ active, over }) => {
                  setDragging(undefined);
                  if (over && over.id !== active.id)
                    reorder(String(active.id), String(over.id));
                }}
              >
                <ul className={styles.list} aria-label="Pinned">
                  {pinned.map((plugin, index) => (
                    <li key={plugin.key}>{row(plugin, index)}</li>
                  ))}
                </ul>
                {createPortal(
                  // The popover is transformed, which would anchor a fixed
                  // preview to it, so the preview sits on the body.
                  <DragOverlay
                    dropAnimation={null}
                    style={{ zIndex: "var(--layer-tooltip)" }}
                  >
                    {draggingPlugin && (
                      <div className={styles.dragOverlay}>
                        <span className={styles.icon} aria-hidden="true">
                          {draggingPlugin.icon}
                        </span>
                        <span>{draggingPlugin.label}</span>
                      </div>
                    )}
                  </DragOverlay>,
                  document.body,
                )}
              </DndContext>
            )}
            {rest.length > 0 && (
              <ul
                className={styles.list}
                data-after-pinned={pinned.length > 0 || undefined}
                aria-label={pinned.length > 0 ? "Other plugins" : undefined}
              >
                {rest.map((plugin, index) => (
                  <li key={plugin.key}>{row(plugin, index)}</li>
                ))}
              </ul>
            )}
            {pinned.length === 0 && rest.length === 0 && (
              <p className={`${styles.empty} text-body-sm`} role="status">
                {searching
                  ? `No plugins match “${query.trim()}”.`
                  : "No plugins are on."}
              </p>
            )}
          </div>
        </div>
      </PopoverPopup>
    </PopoverRoot>
  );
}

function PluginRow({
  plugin,
  move,
  onOpen,
  onPinnedChange,
}: {
  plugin: AllPluginsEntry;
  /** Present for a pinned row that can move. */
  move:
    | {
        previous: string | undefined;
        next: string | undefined;
        reorder: (from: string, to: string) => void;
      }
    | undefined;
  onOpen: (key: string) => void;
  onPinnedChange: AllPluginsProps["onPinnedChange"];
}) {
  const drag = useDraggable({ id: plugin.key, disabled: !move });
  const drop = useDroppable({ id: plugin.key, disabled: !move });
  const { setNodeRef: setDragRef } = drag;
  const { setNodeRef: setDropRef } = drop;
  const node = useCallback(
    (element: HTMLElement | null) => {
      setDragRef(element);
      setDropRef(element);
    },
    [setDragRef, setDropRef],
  );
  return (
    <div
      ref={move ? node : undefined}
      className={styles.row}
      data-dragging={drag.isDragging || undefined}
      data-drop-target={(drop.isOver && !drag.isDragging) || undefined}
    >
      <NavigationCard>
        <span className={styles.grip}>
          {move ? (
            <IconButton
              ref={drag.setActivatorNodeRef}
              // Pointer drag only; the button keeps its own semantics and the
              // arrow keys below are its keyboard path.
              {...drag.listeners}
              aria-label={`Reorder ${plugin.label}`}
              title="Drag, or use the arrow keys, to reorder"
              size="sm"
              variant="glyph"
              icon={<GripVerticalIcon size={16} aria-hidden="true" />}
              onKeyDown={(event) => {
                const to =
                  event.key === "ArrowUp"
                    ? move.previous
                    : event.key === "ArrowDown"
                      ? move.next
                      : undefined;
                if (!to) return;
                event.preventDefault();
                event.stopPropagation();
                move.reorder(plugin.key, to);
              }}
            />
          ) : null}
        </span>
        <NavigationItem
          data-plugin-row=""
          label={plugin.label}
          title={plugin.label}
          icon={
            <span className={styles.icon} aria-hidden="true">
              {plugin.icon}
            </span>
          }
          selected={plugin.active}
          onClick={() => onOpen(plugin.key)}
        />
        <span className={styles.actions} data-plugin-actions="">
          <IconButton
            aria-label={`${plugin.pinned ? "Unpin" : "Pin"} ${plugin.label}`}
            aria-pressed={plugin.pinned}
            size="sm"
            variant="glyph"
            icon={
              plugin.pinned ? (
                <PinFilledIcon size={16} aria-hidden="true" />
              ) : (
                <PinIcon size={16} aria-hidden="true" />
              )
            }
            onClick={() => onPinnedChange(plugin.key, !plugin.pinned)}
          />
        </span>
      </NavigationCard>
    </div>
  );
}

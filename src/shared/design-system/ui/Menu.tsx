import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { CheckIcon, CaretRightIcon } from "../icons/index";
import { useFinalFocusUnlessMoved } from "./finalFocus";
import { hoverOpenTiming, type HoverOpen } from "./hoverIntent";
import {
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { useDeferredTrigger } from "./deferredTrigger";

// null is an ordinary menu; a boolean is a context menu's visible lifetime.
const ContextMenuPresence = createContext<boolean | null>(null);

type DeferredMenuState = {
  handle: BaseMenu.Handle<unknown> | undefined;
  activate(): void;
  root: Omit<BaseMenu.Root.Props<unknown>, "children">;
};

// A deferred menu's root mounts beside its popup once the trigger is used.
const DeferredMenu = createContext<DeferredMenuState | null>(null);

export function MenuRoot<Payload>({
  deferred = false,
  ...props
}: BaseMenu.Root.Props<Payload> & {
  /**
   * Mount the menu's root on the trigger's first pointer, focus or press,
   * for menus repeated per row. The trigger must take its props on its
   * `render` element, and the root needs exactly one `MenuPopup`.
   */
  deferred?: boolean;
}) {
  const handle = useRef<BaseMenu.Handle<Payload>>(undefined);
  const [live, setLive] = useState(false);
  const activate = useCallback(() => {
    handle.current ??= BaseMenu.createHandle<Payload>();
    setLive(true);
  }, []);
  if (deferred && (props.open || props.defaultOpen) && !live) activate();
  if (!deferred)
    return (
      <ContextMenuPresence value={null}>
        <BaseMenu.Root {...props} />
      </ContextMenuPresence>
    );
  const { children, ...root } = props;
  return (
    <ContextMenuPresence value={null}>
      <DeferredMenu
        value={{
          handle: live
            ? (handle.current as BaseMenu.Handle<unknown>)
            : undefined,
          activate,
          root: root as DeferredMenuState["root"],
        }}
      >
        {children as ReactNode}
      </DeferredMenu>
    </ContextMenuPresence>
  );
}

type MenuTriggerProps<Payload> = Omit<
  BaseMenu.Trigger.Props<Payload>,
  "openOnHover" | "delay" | "closeDelay"
> & {
  /** Opening on hover takes its timing from a DESIGN.md "Hover timing" bucket. */
  openOnHover?: HoverOpen | false | undefined;
};

export function MenuTrigger<Payload>({
  openOnHover,
  ...props
}: MenuTriggerProps<Payload>) {
  const menu = useContext(DeferredMenu);
  const timing = openOnHover && {
    openOnHover: true,
    ...hoverOpenTiming[openOnHover],
  };
  if (menu && isValidElement(props.render))
    return (
      <DeferredMenuTrigger
        menu={menu}
        render={props.render}
        trigger={{ ...props, ...timing }}
      />
    );
  return <BaseMenu.Trigger {...props} {...timing} />;
}

function DeferredMenuTrigger({
  menu,
  render,
  trigger: props,
}: {
  menu: DeferredMenuState;
  render: ReactElement;
  trigger: Omit<BaseMenu.Trigger.Props<unknown>, "render">;
}) {
  const node = useRef<HTMLElement | null>(null);
  const triggerId = `base-ui-${useId()}`;
  const trigger = useDeferredTrigger({
    node,
    child: render,
    open: !!menu.handle,
    resting: {
      id: triggerId,
      "aria-haspopup": "menu",
      "aria-expanded": false,
      tabIndex: 0,
    },
    activateOn: [
      "onPointerEnter",
      "onMouseEnter",
      "onPointerDown",
      "onMouseDown",
      "onFocus",
      "onKeyDown",
      "onClick",
    ],
    onActivate: menu.activate,
  });
  return (
    <>
      {trigger.element}
      {menu.handle && (
        <BaseMenu.Trigger
          {...props}
          id={triggerId}
          handle={menu.handle}
          render={trigger.relay}
        />
      )}
    </>
  );
}
export function ContextMenuRoot({
  open,
  defaultOpen,
  onOpenChange,
  onOpenChangeComplete,
  ...props
}: ComponentProps<typeof BaseContextMenu.Root>) {
  const [present, setPresent] = useState(open ?? defaultOpen ?? false);
  // Controlled opens can come from the keyboard without a trigger event.
  if (open && !present) setPresent(true);
  return (
    <ContextMenuPresence value={present}>
      <BaseContextMenu.Root
        {...props}
        open={open}
        defaultOpen={defaultOpen}
        onOpenChange={(next, details) => {
          onOpenChange?.(next, details);
          if (next && open === undefined && !details.isCanceled)
            setPresent(true);
        }}
        onOpenChangeComplete={(next) => {
          if (!next) setPresent(false);
          onOpenChangeComplete?.(next);
        }}
      />
    </ContextMenuPresence>
  );
}

export function ContextMenuTrigger(
  props: ComponentProps<typeof BaseContextMenu.Trigger>,
) {
  const present = useContext(ContextMenuPresence);
  return (
    <BaseContextMenu.Trigger
      {...props}
      data-context-menu-present={present || undefined}
    />
  );
}
export const MenuGroup = BaseMenu.Group;
export const MenuRadioGroup = BaseMenu.RadioGroup;

export type MenuPosition = Pick<
  ComponentProps<typeof BaseMenu.Positioner>,
  | "align"
  | "alignOffset"
  | "anchor"
  | "collisionPadding"
  | "collisionAvoidance"
  | "side"
  | "sideOffset"
  | "sticky"
>;

type PopupProps = Omit<ComponentProps<typeof BaseMenu.Popup>, "className"> &
  MenuPosition & {
    children: ReactNode;
    /** Compact is for short action lists; larger choices retain panel corners. */
    size?: "compact" | "default" | "wide";
  };

function PositionedPopup({
  align = "start",
  alignOffset,
  anchor,
  children,
  collisionAvoidance,
  collisionPadding = 8,
  size = "default",
  side = "bottom",
  sideOffset = 4,
  sticky,
  finalFocus,
  ref,
  ...props
}: PopupProps) {
  const focus = useFinalFocusUnlessMoved(finalFocus, ref);
  const contextMenu = useContext(ContextMenuPresence) !== null;
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner
        className="buzz-menu-positioner"
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionAvoidance={collisionAvoidance}
        collisionPadding={collisionPadding}
        side={side}
        sideOffset={sideOffset}
        sticky={sticky}
      >
        <BaseMenu.Popup
          {...props}
          ref={focus.ref}
          finalFocus={focus.finalFocus}
          data-buzz-ui=""
          data-size={size}
          data-context-menu={contextMenu || undefined}
          className="buzz-menu-popup text-body-sm"
        >
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

/** An anchored action menu with collision handling and shared floating-surface styling. */
export function MenuPopup(props: PopupProps) {
  const menu = useContext(DeferredMenu);
  if (!menu) return <PositionedPopup {...props} />;
  if (!menu.handle) return null;
  return (
    <DeferredMenu value={null}>
      <BaseMenu.Root {...menu.root} handle={menu.handle}>
        <PositionedPopup {...props} />
      </BaseMenu.Root>
    </DeferredMenu>
  );
}

export function MenuSubmenu(
  props: ComponentProps<typeof BaseMenu.SubmenuRoot>,
) {
  return (
    <ContextMenuPresence value={null}>
      <BaseMenu.SubmenuRoot {...props} />
    </ContextMenuPresence>
  );
}

export function MenuSubmenuPopup(props: PopupProps) {
  return <PositionedPopup side="right" align="start" {...props} />;
}

type ItemProps = Omit<ComponentProps<typeof BaseMenu.Item>, "className"> & {
  tone?: "default" | "danger";
};

export function MenuItem({ tone = "default", ...props }: ItemProps) {
  return (
    <BaseMenu.Item {...props} data-tone={tone} className="buzz-menu-item" />
  );
}

type LinkItemProps = Omit<
  ComponentProps<typeof BaseMenu.LinkItem>,
  "className"
>;

export function MenuLinkItem(props: LinkItemProps) {
  return <BaseMenu.LinkItem {...props} className="buzz-menu-item" />;
}

type SubmenuTriggerProps = Omit<
  ComponentProps<typeof BaseMenu.SubmenuTrigger>,
  "className"
>;

export function MenuSubmenuTrigger({
  children,
  ...props
}: SubmenuTriggerProps) {
  return (
    <BaseMenu.SubmenuTrigger delay={0} {...props} className="buzz-menu-item">
      {children}
      <CaretRightIcon
        className="buzz-menu-submenu-arrow"
        size={16}
        aria-hidden="true"
      />
    </BaseMenu.SubmenuTrigger>
  );
}

type CheckboxItemProps = Omit<
  ComponentProps<typeof BaseMenu.CheckboxItem>,
  "className"
>;

export function MenuCheckboxItem({ children, ...props }: CheckboxItemProps) {
  return (
    <BaseMenu.CheckboxItem {...props} className="buzz-menu-item">
      <span className="buzz-menu-choice-label">{children}</span>
      <BaseMenu.CheckboxItemIndicator
        className="buzz-menu-item-indicator"
        keepMounted
      >
        <CheckIcon size={16} aria-hidden="true" />
      </BaseMenu.CheckboxItemIndicator>
    </BaseMenu.CheckboxItem>
  );
}

type RadioItemProps = Omit<
  ComponentProps<typeof BaseMenu.RadioItem>,
  "className"
> & { selection?: "check" | "highlight" };

export function MenuRadioItem({
  children,
  selection = "check",
  ...props
}: RadioItemProps) {
  return (
    <BaseMenu.RadioItem
      {...props}
      className="buzz-menu-item"
      data-selection={selection}
    >
      <span className="buzz-menu-choice-label">{children}</span>
      {selection === "check" && (
        <BaseMenu.RadioItemIndicator
          className="buzz-menu-item-indicator"
          keepMounted
        >
          <CheckIcon size={16} aria-hidden="true" />
        </BaseMenu.RadioItemIndicator>
      )}
    </BaseMenu.RadioItem>
  );
}

export function MenuGroupLabel({
  children,
  emphasis = "default",
}: {
  children: ReactNode;
  emphasis?: "default" | "quiet";
}) {
  return (
    <BaseMenu.GroupLabel
      className="buzz-menu-group-label"
      data-emphasis={emphasis}
    >
      {children}
    </BaseMenu.GroupLabel>
  );
}

export function MenuSeparator() {
  return <BaseMenu.Separator className="buzz-menu-separator" />;
}

export function MenuIcon({ children }: { children: ReactNode }) {
  return (
    <span className="buzz-menu-icon" aria-hidden="true">
      {children}
    </span>
  );
}

export function MenuTrailing({ children }: { children: ReactNode }) {
  return <span className="buzz-menu-trailing">{children}</span>;
}

/** Supporting context and status text, outside the menu's keyboard item list. */
export function MenuNote(props: Omit<ComponentProps<"p">, "className">) {
  return <p {...props} className="buzz-menu-note text-body-sm" />;
}

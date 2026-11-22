import { ACTIVITY_PAGE } from "./activity-context";
import { ActivityNavigationIcon } from "./ActivityNavigation";
import {
  cloneElement,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import type { KeyBinding } from "../../features/shortcuts/bindings";
import { KeyCombo } from "../../features/shortcuts/KeyCombo";
import { KeyboardShortcut } from "../../shared/design-system/ui/KeyboardShortcut";
import { DOCK_HINT_ID, type DockKeyState } from "./DockKeys";
import type {
  PagePreviewProps,
  RegisteredPage,
} from "../../features/pages/service";
import type {
  NavigationOpenOptions,
  OpenResult,
} from "../../features/navigation/controller";
import {
  ContributionBoundary,
  contributionKey,
} from "../../features/conversation/ContributionBoundary";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import { PageIcon } from "./PageIcon";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { BestieUnreadBadge, usePagePresentation } from "./BestieNavigation";
import {
  PopoverPopup,
  PopoverRoot,
  PopoverTrigger,
} from "../../shared/design-system/ui/Popover";
import { EmptyBestieAvatar } from "../../bundled/bestie/EmptyBestieAvatar";

export function PageNavigation({
  pages,
  selected,
  currentPage = selected,
  onSelect,
  placement = "sidebar",
  previews = false,
  dockKeys,
}: {
  pages: readonly RegisteredPage[];
  selected: string;
  /** The open destination when `selected` is the app that lists it. */
  currentPage?: string;
  onSelect(
    key: string,
    options?: Pick<NavigationOpenOptions, "focus" | "onAttempt">,
    // biome-ignore lint/suspicious/noConfusingVoidType: Selectors that ignore the open result stay valid.
  ): Promise<OpenResult> | void;
  /** The app dock is a vertical icon tablist; the sidebar lists rows. */
  placement?: "sidebar" | "dock";
  /** Show inactive page previews in this navigation surface on hover-capable devices. */
  previews?: boolean;
  /** The dock's keyboard mode: numbers, spoken keys and the shortcut hint. */
  dockKeys?: DockKeyState | undefined;
}) {
  const presentation = usePagePresentation();
  const hover = useHoverPointer();
  const previewed = (page: RegisteredPage) =>
    previews && hover && page.key !== selected;
  if (placement === "dock") {
    return (
      <Tabs
        label="Apps"
        variant="dock"
        orientation="vertical"
        value={pages.some((page) => page.key === selected) ? selected : null}
        onValueChange={(key) => onSelect(key, { focus: "preserve" })}
        // The selected app returns from a page opened in its navigation.
        onReselect={(key) => {
          if (key !== currentPage) onSelect(key, { focus: "preserve" });
        }}
        items={pages.map((page, index) => {
          const Badge = page.badge;
          const Preview = page.preview;
          const { icon, image, avatar, label, placeholder } =
            presentation(page);
          const digit = index < 9 ? String(index + 1) : undefined;
          const numbered = dockKeys?.active ? digit : undefined;
          const hint = dockKeys?.chord && (
            <DockShortcut
              chord={dockKeys.chord}
              then={page.key === dockKeys.entry ? undefined : digit}
              apple={dockKeys.apple}
            />
          );
          return {
            value: page.key,
            label,
            keyMarker: numbered,
            keyShortcuts: numbered,
            describedBy: numbered && DOCK_HINT_ID,
            hint: page.key === dockKeys?.entry || digit ? hint : undefined,
            icon: placeholder ? (
              <EmptyBestieAvatar key={page.key} compact />
            ) : avatar ? (
              <Avatar
                src={avatar.src}
                alt=""
                fallback={label}
                shape={avatar.shape}
                size="small"
              />
            ) : (
              <PageIcon icon={icon} image={image} size={20} strokeWidth={2.5} />
            ),
            panelId: `shell-page-${page.key}`,
            renderTab: Preview
              ? (tab: ReactElement<ComponentProps<"button">>) => (
                  <PagePreview
                    page={page}
                    preview={Preview}
                    label={label}
                    enabled={previewed(page)}
                    dockHint
                    hint={
                      page.key === dockKeys?.entry || digit ? hint : undefined
                    }
                  >
                    {tab}
                  </PagePreview>
                )
              : undefined,
            trailing: (
              <>
                {Badge && (
                  <ContributionBoundary
                    key={contributionKey(page)}
                    fallback={null}
                  >
                    <Badge />
                  </ContributionBoundary>
                )}
                <BestieUnreadBadge pageKey={page.key} />
              </>
            ),
          };
        })}
      />
    );
  }
  return pages.map((page) => {
    const { label, icon, image, avatar, placeholder } = presentation(page);
    const Badge = page.badge;
    const badge = Badge && (
      <ContributionBoundary key={contributionKey(page)} fallback={null}>
        <Badge />
      </ContributionBoundary>
    );
    const select = () => {
      onSelect(page.key);
      document.getElementById("main-content")?.focus({ preventScroll: true });
    };
    const pageIcon = placeholder ? (
      <EmptyBestieAvatar key={page.key} compact />
    ) : avatar ? (
      <Avatar
        key={page.key}
        src={avatar.src}
        alt=""
        fallback={label}
        shape={avatar.shape}
        size="compact"
      />
    ) : page.key === ACTIVITY_PAGE ? (
      <ActivityNavigationIcon key={page.key}>
        <PageIcon icon={icon} image={image} size={16} strokeWidth={2.5} />
      </ActivityNavigationIcon>
    ) : (
      <PageIcon
        key={page.key}
        icon={icon}
        image={image}
        size={16}
        strokeWidth={2.5}
      />
    );
    const item = (
      <NavigationItem
        key={page.key}
        onClick={select}
        selected={selected === page.key}
        label={label}
        title={page.preview && previewed(page) ? undefined : label}
        variant="row"
        trailing={badge}
        icon={<span className="shell-page-icon">{pageIcon}</span>}
      />
    );
    return page.preview ? (
      <PagePreview
        key={page.key}
        page={page}
        preview={page.preview}
        label={label}
        enabled={previewed(page)}
      >
        {item}
      </PagePreview>
    ) : (
      item
    );
  });
}

const hoverQuery = "(hover: hover) and (pointer: fine)";
function useHoverPointer() {
  const [hover, setHover] = useState(
    () => window.matchMedia?.(hoverQuery).matches ?? false,
  );
  useEffect(() => {
    const query = window.matchMedia?.(hoverQuery);
    if (!query) return;
    const update = () => setHover(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return hover;
}

/** The shell owns a preview's trigger, timing, placement and dismissal; the
 * page supplies only the content. */
function PagePreview({
  page,
  preview: Preview,
  label,
  enabled,
  dockHint = false,
  hint,
  children,
}: {
  page: RegisteredPage;
  preview: ComponentType<PagePreviewProps>;
  label: string;
  enabled: boolean;
  /** Dock tabs show their label as an instant hint beside the dock. */
  dockHint?: boolean;
  /** Shown after the dock label, such as its shortcut. */
  hint?: ReactNode;
  children: ReactElement<ComponentProps<"button">>;
}) {
  const [open, setOpen] = useState(false);
  // Previews stay below the window header, in the workspace that holds the row.
  const [boundary, setBoundary] = useState<Element | null>(null);
  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);
  const actions =
    useRef<
      NonNullable<ComponentProps<typeof PopoverRoot>["actionsRef"]>["current"]
    >(null);
  // Content that opens something hands focus to it; Base UI would otherwise
  // return focus to this row after closing.
  const handoff = useRef(false);
  const popup = useRef<HTMLDivElement>(null);
  const close = () => {
    handoff.current = true;
    if (actions.current) actions.current.close();
    else setOpen(false);
  };
  // Keep both trigger wrappers mounted while selection switches between a
  // rich preview and the dock's instant label, preserving the focused tab.
  const trigger = (
    <PopoverTrigger
      openOnHover={enabled ? "preview" : false}
      data-popup-preview={enabled ? "" : undefined}
      render={cloneElement(children, {
        title: enabled || dockHint ? undefined : label,
        "aria-haspopup": enabled ? "dialog" : undefined,
        "aria-expanded": enabled ? open : undefined,
      })}
    />
  );
  return (
    <PopoverRoot
      modal={false}
      open={enabled && open}
      actionsRef={actions}
      onOpenChange={(next, details) => {
        // Hover only: pressing the row selects the page instead.
        if (next) {
          handoff.current = false;
          setBoundary(details.trigger?.closest(".shell-workspace") ?? null);
        }
        setOpen(enabled && next && details.reason !== "trigger-press");
      }}
    >
      {/* Marked transient, so a conversation's default focus is not held back. */}
      {dockHint ? (
        <Tooltip
          content={
            hint ? (
              <span className="buzz-tabs-hint">
                {label}
                {hint}
              </span>
            ) : (
              label
            )
          }
          hint="dock"
          side="right"
          // Keyboard focus opens only the label; the preview replaces it once
          // a resting pointer opens it.
          {...(enabled && open ? { open: false } : {})}
        >
          {trigger}
        </Tooltip>
      ) : (
        trigger
      )}
      <PopoverPopup
        size="wide"
        padding="list"
        side="right"
        align="start"
        // 6px beside the row's hover background, lifted so the line under the
        // preview's header meets the background's top edge. Offsets ignore the
        // open animation's transform.
        sideOffset={6}
        collisionBoundary={boundary ?? undefined}
        alignOffset={() => {
          const header = popup.current?.querySelector("header");
          return header ? 1 - header.offsetTop - header.offsetHeight : 0;
        }}
        ref={popup}
        aria-label={label}
        finalFocus={() => !handoff.current}
      >
        <ContributionBoundary key={contributionKey(page)} fallback={null}>
          <Preview close={close} />
        </ContributionBoundary>
      </PopoverPopup>
    </PopoverRoot>
  );
}

/** "⌘D ⌘D" for the tab dock mode starts on, "⌘D 2" for the rest. */
function DockShortcut({
  chord,
  then,
  apple,
}: {
  chord: KeyBinding;
  then: string | undefined;
  apple: boolean;
}) {
  return (
    <>
      <KeyCombo binding={chord} apple={apple} />
      {then ? (
        <KeyboardShortcut text={then} label={then} />
      ) : (
        <KeyCombo binding={chord} apple={apple} />
      )}
    </>
  );
}

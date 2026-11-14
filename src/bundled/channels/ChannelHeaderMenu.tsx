import {
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useHeaderToolsMenu } from "../../features/conversation/ConversationHeaderTools";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { RegisteredPanel } from "../../features/panels/service";
import { useChannelReadAction } from "./useChannelReadAction";
import {
  useChannelMenuActions,
  useChannelNavigation,
  type ChannelMenuSurface,
} from "../../features/channel-navigation/ChannelNavigationState";
import {
  DotsThreeIcon,
  InfoIcon,
  FileTextIcon,
  HashArrowInIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuIcon,
  MenuNote,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import { ChannelLifecycleMenu } from "./ChannelLifecycleMenu";
import { lifecycleNoun } from "./ChannelLifecycleDialog";

/** Entry points only: editors and the sidebar retain dialog and mutation ownership. */
export function ChannelHeaderMenu({
  channel,
  session,
  origin: lifetime,
  trigger,
  openDetails,
  menuPanels,
  openMenuPanel,
  finishConversion,
  startChat,
  size = "toolbar",
  label = "Channel actions",
}: {
  channel: ChannelSummary | undefined;
  session: RelaySession;
  origin?: AbortSignal | undefined;
  trigger: RefObject<HTMLButtonElement | null>;
  openDetails(): void;
  startChat?: ReactNode;
  size?: "toolbar" | "compact";
  label?: string;
  finishConversion?: (() => void) | undefined;
  menuPanels?: readonly RegisteredPanel[] | undefined;
  openMenuPanel?: ((panel: RegisteredPanel) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const overflow = useHeaderToolsMenu();
  const overflowTrigger = overflow?.trigger;
  useLayoutEffect(() => {
    if (!overflowTrigger) return;
    const element = overflowTrigger.current;
    trigger.current = element;
    return () => {
      if (trigger.current === element) trigger.current = null;
    };
  }, [overflowTrigger, trigger]);
  const localFinalFocus = useRef<(() => HTMLElement | false) | undefined>(
    undefined,
  );
  const finalFocus = overflow?.finalFocus ?? localFinalFocus;
  const handoff = useChannelNavigation();
  const readAction = useChannelReadAction();
  const inlineOpen = overflow?.open;
  const resetRead = readAction.reset;
  useEffect(() => {
    if (inlineOpen !== undefined) resetRead();
  }, [inlineOpen, resetRead]);
  const origin = overflow?.trigger.current ?? trigger.current;
  const surface: ChannelMenuSurface = {
    signal: lifetime,
    close: (focus) => {
      finalFocus.current = focus;
      readAction.reset();
      setOpen(false);
      overflow?.close();
    },
    focus: () => {
      if (!lifetime?.aborted && origin?.isConnected)
        origin.focus({ preventScroll: true });
    },
    pending: readAction.state?.pending ?? false,
    runRead: (action) =>
      readAction.run(action, () => {
        readAction.reset();
        setOpen(false);
        overflow?.close();
      }),
  };
  const popup = (lifecycle: ReactNode) => {
    const content = (
      <>
        {startChat}
        {finishConversion && (
          <MenuItem onClick={finishConversion}>
            <MenuIcon>
              <HashArrowInIcon size={16} />
            </MenuIcon>
            Finish conversion
          </MenuItem>
        )}
        <MenuItem
          onClick={() => {
            // WebKit can drop the tab's focus before the menu finishes closing.
            finalFocus.current = () =>
              document.querySelector<HTMLElement>(
                '[data-panel-workspace] [data-tab-value="settings"]',
              ) ??
              trigger.current ??
              false;
            openDetails();
          }}
        >
          <MenuIcon>
            <InfoIcon size={16} />
          </MenuIcon>
          View channel details
        </MenuItem>
        {menuPanels?.map((panel) => (
          <MenuItem key={panel.key} onClick={() => openMenuPanel?.(panel)}>
            <MenuIcon>
              <FileTextIcon size={16} />
            </MenuIcon>
            {panel.channelMenu?.label}
          </MenuItem>
        ))}
        {channel && (
          <ChannelHeaderActions channel={channel} surface={surface} />
        )}
        {readAction.state?.pending && (
          <MenuNote role="status">Saving…</MenuNote>
        )}
        {readAction.state?.error && (
          <MenuNote role="alert">{readAction.state.error}</MenuNote>
        )}
        {lifecycle}
      </>
    );
    return overflow ? (
      content
    ) : (
      <MenuPopup
        size="compact"
        align="end"
        finalFocus={() =>
          finalFocus.current ? finalFocus.current() : (trigger.current ?? false)
        }
      >
        {content}
      </MenuPopup>
    );
  };
  const content = popup(
    channel &&
      handoff &&
      (!channel.readOnly || channel.viewerRole === "guest") &&
      !channel.cached &&
      !channel.archived ? (
      <ChannelLifecycleMenu
        channel={channel}
        session={session}
        disabled={!!handoff.lifecycleDialog}
        separator
        noun={lifecycleNoun(channel)}
        choose={(action) =>
          handoff.openLifecycle(
            channel,
            action,
            trigger.current ?? undefined,
            lifetime,
          )
        }
      />
    ) : null,
  );
  return overflow ? (
    content
  ) : (
    <MenuRoot
      open={open}
      onOpenChange={(next) => {
        readAction.reset();
        setOpen(next);
        if (next) finalFocus.current = undefined;
      }}
    >
      <MenuTrigger
        openOnHover="control"
        render={
          <IconButton
            hint="familiar"
            ref={trigger}
            size={size}
            aria-label={label}
            title={label}
            data-highlight-expanded="false"
            icon={<DotsThreeIcon size="1rem" aria-hidden="true" />}
          />
        }
      />
      {content}
    </MenuRoot>
  );
}

// The popup owns this lifetime so submenu focus survives its closing transition.
function ChannelHeaderActions({
  channel,
  surface,
}: {
  channel: ChannelSummary;
  surface: ChannelMenuSurface;
}) {
  const menuActions = useChannelMenuActions();
  const actions = menuActions?.(channel, surface);
  return actions?.length ? (
    <>
      <MenuSeparator />
      {actions}
    </>
  ) : null;
}

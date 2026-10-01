import { useRef, useState, type ReactNode, type RefObject } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type {
  TemplateProvider,
  TemplateProviders,
} from "../../features/channel-templates/provider";
import type { Contribution } from "../../plugins/contributions";
import { OwnedContribution } from "../../plugins/OwnedContribution";
import { useChannelReadAction } from "./useChannelReadAction";
import {
  useChannelMenuActions,
  useChannelNavigation,
} from "../../features/channel-navigation/ChannelNavigationState";
import {
  DotsThreeIcon,
  FileTextIcon,
  InfoIcon,
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
import { ChannelDetailsEditor } from "./ChannelDetailsEditor";
import { ChannelLifecycleMenu } from "./ChannelLifecycleMenu";

/** Entry points only: editors and the sidebar retain dialog and mutation ownership. */
export function ChannelHeaderMenu({
  channel,
  session,
  providers,
  templateProvider,
  trigger,
  openDetails,
  openCanvas,
}: {
  channel: ChannelSummary | undefined;
  session: RelaySession;
  providers: TemplateProviders;
  templateProvider: Contribution<TemplateProvider> | undefined;
  trigger: RefObject<HTMLButtonElement | null>;
  openDetails(): void;
  openCanvas(trigger: HTMLButtonElement): void;
}) {
  const [open, setOpen] = useState(false);
  const [prepared, setPrepared] = useState(false);
  const finalFocus = useRef<(() => HTMLElement | false) | undefined>(undefined);
  const handoff = useChannelNavigation();
  const menuActions = useChannelMenuActions();
  const readAction = useChannelReadAction();
  const origin = trigger.current;
  const actions = channel
    ? menuActions?.(channel, {
        close: (focus) => {
          finalFocus.current = focus;
          readAction.reset();
          setOpen(false);
        },
        focus: () => {
          if (origin?.isConnected) origin.focus({ preventScroll: true });
        },
        pending: readAction.state?.pending ?? false,
        runRead: (action) =>
          readAction.run(action, () => {
            readAction.reset();
            setOpen(false);
          }),
      })
    : undefined;
  const popup = (
    lifecycle: ReactNode,
    edit?: ReactNode,
    saveAs?: ReactNode,
  ) => (
    <MenuPopup
      size="default"
      align="end"
      finalFocus={() =>
        finalFocus.current ? finalFocus.current() : (trigger.current ?? false)
      }
    >
      <MenuItem onClick={openDetails}>
        <MenuIcon>
          <InfoIcon size={16} />
        </MenuIcon>
        Channel details
      </MenuItem>
      {channel && !channel.readOnly && (
        <MenuItem
          onClick={() => {
            if (trigger.current) openCanvas(trigger.current);
          }}
        >
          <MenuIcon>
            <FileTextIcon size={16} />
          </MenuIcon>
          Canvas
        </MenuItem>
      )}
      {edit}
      {saveAs}
      {!!actions?.length && <MenuSeparator />}
      {actions}
      {readAction.state?.pending && <MenuNote role="status">Saving…</MenuNote>}
      {readAction.state?.error && (
        <MenuNote role="alert">{readAction.state.error}</MenuNote>
      )}
      {lifecycle}
    </MenuPopup>
  );
  // Keep dialog owners outside the menu portal: closing it must not unmount a
  // draft, an in-flight template read, or an uncertain details-save recovery.
  const withTemplate = (lifecycle: ReactNode, edit?: ReactNode) =>
    prepared && channel && templateProvider ? (
      <OwnedContribution
        entry={templateProvider}
        registry={providers}
        fallback={popup(
          lifecycle,
          edit,
          <MenuNote role="alert">Templates unavailable</MenuNote>,
        )}
      >
        {(entry, active) => {
          const SaveAs = entry.saveAs;
          return (
            <SaveAs
              session={session}
              channel={channel}
              active={active}
              menu={{
                close: () => setOpen(false),
                finalFocus: trigger,
                render: (items) => popup(lifecycle, edit, items),
              }}
            />
          );
        }}
      </OwnedContribution>
    ) : (
      popup(lifecycle, edit)
    );
  const editable =
    channel &&
    !channel.readOnly &&
    !channel.cached &&
    !channel.archived &&
    (channel.channelType === "stream" || channel.channelType === "forum");
  const withDetails = (lifecycle: ReactNode) =>
    prepared && editable && session.channelDetails.available ? (
      <ChannelDetailsEditor
        channel={channel}
        capability={session.channelDetails}
        menu={{
          open,
          finalFocus: trigger,
          render: (items) => withTemplate(lifecycle, items),
        }}
      />
    ) : (
      withTemplate(lifecycle)
    );
  return (
    <MenuRoot
      open={open}
      onOpenChange={(next) => {
        readAction.reset();
        setOpen(next);
        if (next) {
          finalFocus.current = undefined;
          setPrepared(true);
        }
      }}
    >
      <MenuTrigger
        render={
          <IconButton
            ref={trigger}
            size="toolbar"
            aria-label="Channel actions"
            title="Channel actions"
            data-highlight-expanded="false"
            icon={<DotsThreeIcon size="1rem" aria-hidden="true" />}
          />
        }
      />
      {prepared &&
      channel &&
      handoff &&
      !channel.readOnly &&
      !channel.cached &&
      !channel.archived &&
      channel.channelType !== "session" ? (
        <ChannelLifecycleMenu
          channelId={channel.id}
          lifecycle={session.channelLifecycle}
          open={open}
          disabled={!!handoff.lifecycleDialog}
          separator
          choose={(action) =>
            handoff.openLifecycle(channel, action, trigger.current ?? undefined)
          }
          render={withDetails}
        />
      ) : (
        withDetails(null)
      )}
    </MenuRoot>
  );
}

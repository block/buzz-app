import { usePanelTabHost } from "../../features/panels/PanelWorkspace";
import { useEffect, useId, useRef, type ReactNode } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import { channelIcon } from "../../features/channels/channel-icon";
import { GearIcon } from "../../shared/design-system/icons/index";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { Panel } from "../../shared/design-system/ui/Panel";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import styles from "./Channels.module.css";
import type { ChannelDetailsCapability } from "../../features/relay/channel-details";
import { ChannelDetailsEditor } from "./ChannelDetailsEditor";

export function ChannelSettingsPanel({
  channel,
  close,
  children,
  setupTools,
  details,
}: {
  channel: ChannelSummary | undefined;
  close(): void;
  children: ReactNode;
  setupTools?: ReactNode;
  details?: ChannelDetailsCapability;
}) {
  const tabbed = !!usePanelTabHost();
  const header = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (tabbed) return;
    header.current
      ?.querySelector<HTMLElement>('[role="tab"]')
      ?.focus({ preventScroll: true });
  }, [tabbed]);
  const ChannelIcon = channelIcon(channel);
  return (
    <Panel
      as="aside"
      aria-label="Channel settings"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      <div ref={header} className={styles.settingsPanel}>
        {!tabbed && (
          <PanelHeader
            title={
              <Tabs
                variant="navigation"
                label="Panel tabs"
                value="settings"
                onValueChange={() => {}}
                items={[
                  {
                    value: "settings",
                    label: "Channel settings",
                    icon: <GearIcon size="1rem" />,
                    panelId,
                    onClose: close,
                  },
                ]}
              />
            }
          />
        )}
        <div
          id={tabbed ? undefined : panelId}
          {...(!tabbed
            ? { role: "tabpanel", "aria-labelledby": `${panelId}-tab` }
            : {})}
          className={styles.settingsContent}
        >
          {channel && (
            <>
              <div className={styles.settingsIdentity}>
                <span className={styles.settingsIcon}>
                  <ChannelIcon size={32} aria-hidden="true" />
                </span>
                <h3 className="text-heading text-primary">{channel.name}</h3>
              </div>
              <dl className={styles.settingsDetails}>
                {channel.channelType !== "session" &&
                  channel.channelType !== "dm" && (
                    <>
                      <div>
                        <dt>Description</dt>
                        <dd className={styles.settingsDescription}>
                          {channel.description === undefined
                            ? "Not available"
                            : channel.description || "No description"}
                        </dd>
                      </div>
                      <div>
                        <dt>Visibility</dt>
                        <dd>
                          {channel.visibility === "public"
                            ? "Public"
                            : channel.visibility === "private"
                              ? "Private"
                              : "Not available"}
                        </dd>
                      </div>
                    </>
                  )}
                {channel.channelType && (
                  <div>
                    <dt>Channel type</dt>
                    <dd>
                      {channel.channelType === "dm"
                        ? "Direct message"
                        : channel.channelType === "forum"
                          ? "Forum"
                          : channel.channelType === "session"
                            ? "Session"
                            : "Channel"}
                    </dd>
                  </div>
                )}
                {channel.members && (
                  <div>
                    <dt>Members</dt>
                    <dd>{channel.members.length}</dd>
                  </div>
                )}
                <div>
                  <dt>Channel ID</dt>
                  <dd className={styles.settingsId}>{channel.id}</dd>
                </div>
              </dl>
            </>
          )}
          {channel &&
            (channel.channelType === "stream" ||
              channel.channelType === "forum") &&
            !channel.readOnly &&
            !channel.cached &&
            !channel.archived &&
            (details?.available ? (
              <ChannelDetailsEditor channel={channel} capability={details} />
            ) : (
              <p>Editing is unavailable on this connection.</p>
            ))}
          {setupTools}
          <details className={styles.settingsDiagnostics}>
            <summary>Diagnostics</summary>
            <div className={styles.settingsTools}>{children}</div>
          </details>
        </div>
      </div>
    </Panel>
  );
}

import { usePanelTabHost } from "../../features/panels/PanelWorkspace";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import { channelIcon } from "../../features/channels/channel-icon";
import type { ChannelCanvas } from "../../features/channel-templates/capability";
import { canvasPreviewText } from "./canvas-preview";
import { ChoiceRow } from "../../shared/design-system/ui/ChoiceRow";
import {
  GearIcon,
  CaretRightIcon,
  FileTextIcon,
} from "../../shared/design-system/icons/index";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { Panel } from "../../shared/design-system/ui/Panel";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import styles from "./Channels.module.css";
import type { ChannelDetailsCapability } from "../../features/relay/channel-details";
import {
  ChannelDetailsEditor,
  type ChannelDetailsAction,
} from "./ChannelDetailsEditor";

export function ChannelSettingsPanel({
  channel,
  scope,
  close,
  children,
  setupTools,
  details,
  openCanvas,
  canvas,
  canvasOpen = false,
  openMembers,
}: {
  channel: ChannelSummary | undefined;
  scope: string;
  close(): void;
  children: ReactNode;
  setupTools?: ReactNode;
  details?: ChannelDetailsCapability;
  openCanvas?(trigger: HTMLButtonElement): void;
  canvas?: ChannelCanvas;
  canvasOpen?: boolean;
  openMembers?(trigger: HTMLButtonElement): void;
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
  const channelId =
    channel && !channel.readOnly && openCanvas ? channel.id : undefined;
  const [preview, setPreview] = useState<{
    canvas: ChannelCanvas;
    channelId: string;
    text: string;
    failed?: boolean;
  }>();
  useEffect(() => {
    if (!canvas || !channelId || canvasOpen) return;
    setPreview(undefined);
    let active = true;
    void canvas.read(channelId).then(
      (event) => {
        if (active)
          setPreview({
            canvas,
            channelId,
            text: canvasPreviewText(event?.content ?? ""),
          });
      },
      () => {
        if (active) setPreview({ canvas, channelId, text: "", failed: true });
      },
    );
    return () => {
      active = false;
    };
  }, [canvas, channelId, canvasOpen]);
  const currentPreview =
    preview?.canvas === canvas && preview?.channelId === channelId
      ? preview
      : undefined;
  const previewText = currentPreview?.text ?? "";
  const previewFallback = currentPreview?.failed
    ? "Preview unavailable. Open to retry."
    : currentPreview
      ? "No content yet"
      : "Loading preview…";
  const ChannelIcon = channelIcon(channel);
  const renderPanel = (edit?: ChannelDetailsAction, editStatus?: ReactNode) => (
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
                      <SettingsDetail
                        label="Description"
                        value={
                          channel.description === undefined
                            ? "Not available"
                            : channel.description || "No description"
                        }
                        valueClassName={styles.settingsDescription}
                        actionLabel={edit?.label}
                        onOpen={edit?.open}
                      />
                      <SettingsDetail
                        label="Visibility"
                        value={
                          channel.visibility === "public"
                            ? "Public"
                            : channel.visibility === "private"
                              ? "Private"
                              : "Not available"
                        }
                        actionLabel={edit?.label}
                        onOpen={edit?.open}
                      />
                    </>
                  )}
                {channel.members && (
                  <SettingsDetail
                    label="Members"
                    value={String(channel.members.length)}
                    onOpen={openMembers}
                  />
                )}
                <div>
                  <dt>Channel ID</dt>
                  <dd className={styles.settingsId}>{channel.id}</dd>
                </div>
              </dl>
            </>
          )}
          {channel && !channel.readOnly && openCanvas && (
            <button
              type="button"
              className={styles.settingsCanvas}
              aria-label="Canvas"
              aria-description={previewText || previewFallback}
              aria-haspopup="dialog"
              onClick={(event) => openCanvas(event.currentTarget)}
            >
              <ChoiceRow
                leading={<FileTextIcon size={20} aria-hidden="true" />}
                label="Canvas"
                description={
                  previewText ? (
                    <span className={styles.settingsCanvasPreview}>
                      {previewText}
                    </span>
                  ) : (
                    previewFallback
                  )
                }
                trailing={<CaretRightIcon size={16} aria-hidden="true" />}
              />
            </button>
          )}
          {editStatus}
          {setupTools}
          <details className={styles.settingsDiagnostics}>
            <summary>Diagnostics</summary>
            <div className={styles.settingsTools}>{children}</div>
          </details>
        </div>
      </div>
    </Panel>
  );
  const editable =
    channel &&
    (channel.channelType === "stream" || channel.channelType === "forum") &&
    !channel.readOnly &&
    !channel.cached &&
    !channel.archived;
  return editable && details?.available ? (
    <ChannelDetailsEditor
      channel={channel}
      capability={details}
      scope={scope}
      renderSurface={renderPanel}
    />
  ) : (
    renderPanel(
      undefined,
      editable ? <p>Editing is unavailable on this connection.</p> : undefined,
    )
  );
}

/** A native button's hit area covers the row without nesting controls or losing list semantics. */
function SettingsDetail({
  label,
  value,
  valueClassName,
  actionLabel,
  onOpen,
}: {
  label: string;
  value: string;
  valueClassName?: string | undefined;
  actionLabel?: string | undefined;
  onOpen?: ((trigger: HTMLButtonElement) => void) | undefined;
}) {
  return (
    <div>
      <dt>
        {onOpen ? (
          <button
            type="button"
            className={styles.settingsDetailAction}
            aria-label={
              actionLabel
                ? `${actionLabel} ${label.toLowerCase()}`
                : `View ${label.toLowerCase()}`
            }
            aria-description={value}
            aria-haspopup="dialog"
            onClick={(event) => onOpen(event.currentTarget)}
          >
            <span>{label}</span>
            {actionLabel && <span className="text-link">{actionLabel}</span>}
          </button>
        ) : (
          label
        )}
      </dt>
      <dd className={valueClassName}>{value}</dd>
    </div>
  );
}

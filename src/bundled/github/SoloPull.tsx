import { useCallback, useState, useSyncExternalStore } from "react";
import { MenuItem, MenuIcon } from "../../shared/design-system/ui/Menu";
import { LinkBreakIcon } from "../../shared/design-system/icons";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import type { ChannelLauncherProps } from "../../features/panels/service";
import { useRelayConnection } from "../../features/relay/react";
import type { ChatIconProps } from "../../features/conversation/service";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { useChannelList } from "../../features/relay/react";
import { ownSolo } from "../../features/solo/labels";
import {
  linkPull,
  unlinkPull,
  writeLinks,
  type SoloPull,
  type SoloPulls,
} from "./solo-pull";
import { parseGitHubReference } from "./references";
import { describePull, pullTone, stateIcons } from "./pull-state-view";
import styles from "./GitHub.module.css";
import { useOpenGitHubLinksInBuzz } from "./link-preference";

/** Which linked pull request the chat icon shows: the one most in need of
 * attention, then the earliest linked. */
const urgency = [
  "failure",
  "pending",
  "draft",
  "open",
  "unknown",
  "merged",
  "closed",
];
export function mostUrgent(pulls: readonly SoloPull[]) {
  const rank = (pull: SoloPull) => urgency.indexOf(pullTone(pull));
  return pulls.reduce((shown, pull) =>
    rank(pull) < rank(shown) ? pull : shown,
  );
}

/** A pull request's short name, such as `owner/repo#12`. */
const pullName = (pull: SoloPull) => {
  const reference = parseGitHubReference(pull.url);
  return reference ? `${reference.repository}${reference.label}` : pull.url;
};

/** A Solo chat's linked pull requests in place of its chat icon: the one most
 * in need of attention, with every one in its description. */
export function SoloPullIcon({
  pulls,
  channelId,
  fallback,
}: Pick<ChatIconProps, "channelId" | "fallback"> & { pulls: SoloPulls }) {
  const linked = useSoloPulls(pulls, channelId);
  if (!linked) return fallback;
  const pull = mostUrgent(linked);
  const Icon = stateIcons[pull.state?.state ?? "open"];
  const description =
    linked.length === 1
      ? describePull(pull)
      : linked
          .map((item) => `${pullName(item)}: ${describePull(item)}`)
          .join("\n");
  return (
    <span
      className={styles.soloPull}
      data-tone={pullTone(pull)}
      title={linked.length > 1 ? description : undefined}
    >
      <Icon size={16} aria-hidden="true" />
      <span className="sr-only">
        {linked.length === 1
          ? `${description}: `
          : `${linked.length} pull requests (${description.replaceAll("\n", "; ")}). `}
      </span>
    </span>
  );
}

/** Reuses the sidebar's linked state and the conversation host's panel opener. */
export function SoloPullLauncher({
  relay,
  pullsFor,
  context,
  open,
  canOpen,
}: ChannelLauncherProps & {
  relay: RelayData;
  pullsFor(session: RelaySession): SoloPulls;
}) {
  const connection = useRelayConnection(relay);
  const list = useChannelList(connection.session.channels);
  if (
    list.channels.find((channel) => channel.id === context.channelId)
      ?.channelType !== "solo" ||
    connection.scope !== context.scope ||
    connection.viewer !== context.viewer
  )
    return null;
  return (
    <SessionPullLauncher
      pulls={pullsFor(connection.session)}
      channelId={context.channelId}
      open={open}
      canOpen={canOpen}
    />
  );
}

export function SessionPullLauncher({
  pulls,
  channelId,
  open,
  canOpen,
}: {
  pulls: SoloPulls;
  channelId: string;
  open(target: string): boolean;
  canOpen(target: string): boolean;
}) {
  const inBuzz = useOpenGitHubLinksInBuzz();
  const linked = useSoloPulls(pulls, channelId);
  return (
    linked?.map((pull) => {
      const label = `Open linked ${describePull(pull).toLowerCase()}${
        linked.length > 1 ? `, ${pullName(pull)}` : ""
      }`;
      const Icon = stateIcons[pull.state?.state ?? "open"];
      return (
        <IconButton
          key={pull.url}
          size="sm"
          variant="ghost"
          aria-label={label}
          title={label}
          disabled={inBuzz && !canOpen(pull.url)}
          icon={<Icon size="1rem" aria-hidden="true" />}
          {...(inBuzz
            ? { onClick: () => open(pull.url) }
            : {
                nativeButton: false,
                role: "link",
                render: (props) => (
                  <a
                    {...props}
                    href={pull.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  />
                ),
              })}
        />
      );
    }) ?? null
  );
}

function useSoloPulls(pulls: SoloPulls, channelId: string) {
  const subscribe = useCallback(
    (listener: () => void) => pulls.watch(channelId, listener),
    [pulls, channelId],
  );
  return useSyncExternalStore(subscribe, () => pulls.get(channelId));
}

/** Links the pull request in the panel to the Solo chat it was opened from,
 * where the person's app can write the link. */
export function SoloPullLink({
  relay,
  pullsFor,
  channelId,
  url,
}: {
  relay: RelayData;
  pullsFor(session: RelaySession): SoloPulls;
  channelId: string;
  url: string;
}) {
  const state = useSyncExternalStore(relay.subscribe, relay.snapshot);
  return state.status === "ready" && state.session.configArtifactWriter ? (
    <SessionPullLink
      key={state.generation}
      session={state.session}
      pulls={pullsFor(state.session)}
      channelId={channelId}
      url={url}
    />
  ) : null;
}

function SessionPullLink({
  session,
  pulls,
  channelId,
  url,
}: {
  session: RelaySession;
  pulls: SoloPulls;
  channelId: string;
  url: string;
}) {
  const list = useChannelList(session.channels);
  const linked = !!useSoloPulls(pulls, channelId)?.some(
    (pull) => pull.url === url,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const channel = list.channels.find((item) => item.id === channelId);
  if (!ownSolo(channel, session.viewer)) return null;
  const change = async (link: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      pulls.linked(
        channelId,
        await writeLinks(
          session,
          channelId,
          link ? linkPull(url) : unlinkPull(url),
        ),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.soloLink}>
      <span className={styles.pullActionNote}>
        {linked
          ? "Shown in the sidebar for this chat."
          : "Show this pull request’s state in the sidebar for this chat."}
      </span>
      <Button size="sm" loading={busy} onClick={() => void change(!linked)}>
        {linked ? "Unlink" : "Link to this chat"}
      </Button>
      {error && (
        <p role="alert" className={styles.pullActionError}>
          {error}
        </p>
      )}
    </div>
  );
}

export function SoloPullMenu({
  session,
  pulls,
  channelId,
}: {
  session: RelaySession;
  pulls: SoloPulls;
  channelId: string;
}) {
  const linked = useSoloPulls(pulls, channelId);
  const list = useChannelList(session.channels);
  const [busy, setBusy] = useState<string>();
  const notify = useToastNotification();
  const channel = list.channels.find((item) => item.id === channelId);
  if (
    !linked ||
    !ownSolo(channel, session.viewer) ||
    channel?.archived ||
    channel?.readOnly
  )
    return null;
  const writable = !!session.configArtifactWriter && !!session.snapshotRead;
  return linked.map((pull) => (
    <MenuItem
      key={pull.url}
      disabled={!!busy || !writable}
      title={
        writable
          ? undefined
          : "Unlinking needs a native desktop relay connection."
      }
      closeOnClick={false}
      onClick={async () => {
        if (busy) return;
        setBusy(pull.url);
        try {
          pulls.linked(
            channelId,
            await writeLinks(session, channelId, unlinkPull(pull.url)),
          );
          notify("Pull request unlinked", "success");
        } catch (error) {
          notify(
            error instanceof Error
              ? error.message
              : "Couldn’t unlink pull request. Try again.",
            "error",
          );
        } finally {
          setBusy(undefined);
        }
      }}
    >
      <MenuIcon>
        <LinkBreakIcon size={16} />
      </MenuIcon>
      {busy === pull.url
        ? "Unlinking pull request…"
        : linked.length === 1
          ? "Unlink pull request"
          : `Unlink ${pullName(pull)}`}
    </MenuItem>
  ));
}

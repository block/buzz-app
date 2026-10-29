import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ChannelDetailsCapability } from "../../features/relay/channel-details";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelayRecovery } from "../../features/relay/recovery";
import { useReauthorizedRetry } from "../../features/relay/RecoveryNotice";
import type {
  ChannelDetails,
  ChannelDetailsDraft,
} from "../../features/relay/channel-details-protocol";
import { Button } from "../../shared/design-system/ui/Button";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Select } from "../../shared/design-system/ui/Select";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Field } from "../../shared/design-system/ui/Field";
import type { CommunityReader } from "../../features/communities/service";
import { communityName } from "../../features/communities/names";
import { communityFromScope } from "../../features/relay/gifs";
import { communityDestination } from "../../features/communities/destination";
import {
  CircleNotchIcon,
  LockIcon,
  GlobeIcon,
} from "../../shared/design-system/icons";
import styles from "./ChannelMembersDialog.module.css";
import { privacyConsequence } from "./ChannelPrivacyConfirmation";

const noCommunitySubscription = () => () => {};
const participationOptions = [
  {
    label: "",
    options: [
      {
        value: "member",
        label: "Participate",
        description: "Send messages, reply, and react.",
      },
      {
        value: "guest",
        label: "View only",
        description: "Read messages and threads.",
      },
    ],
  },
];

/** General access uses the same signed save/readback owner as channel details.
 * Choices are confirmed individually, like the member rows above this section. */
export function ChannelGeneralAccess({
  communityReader,
  communityScope,
  capability,
  recovery,
  channelId,
  channel,
}: {
  communityReader?: CommunityReader | undefined;
  communityScope?: string | undefined;
  capability: ChannelDetailsCapability;
  recovery?: RelayRecovery | undefined;
  channelId: string;
  channel?: ChannelSummary;
}) {
  const origin = communityScope ? communityFromScope(communityScope) : null;
  const community = useSyncExternalStore(
    communityReader?.subscribe ?? noCommunitySubscription,
    () =>
      communityReader
        ?.snapshot()
        .memberships.find(
          (entry) => communityDestination(entry.id).url === origin,
        ),
  );
  const communityAvatar = (size: "compact" | "default") =>
    community ? (
      <Avatar
        alt=""
        src={community.publishedIcon ?? community.icon}
        fallback={communityName(community)}
        shape="squircle"
        size={size}
      />
    ) : (
      <GlobeIcon size={24} />
    );
  // Public previews and Guests can inspect signed discovery metadata without
  // calling the membership/write-gated channel-details capability.
  if (channel?.readOnly)
    return (
      <section aria-label="General access" className={styles.generalAccess}>
        <div className={styles.accessRow}>
          <span className={styles.accessIcon} aria-hidden="true">
            {channel.visibility === "public" ? (
              communityAvatar("default")
            ) : (
              <Avatar
                alt=""
                fallback=""
                fallbackContent={<LockIcon size={24} />}
                shape="squircle"
              />
            )}
          </span>
          <div className={styles.accessAudience}>
            <p className="text-body-sm">
              {channel.visibility === "public"
                ? "Anyone in the community can read."
                : channel.visibility === "private"
                  ? "Only channel members can read."
                  : "Reading access could not be confirmed."}
            </p>
            <p className="text-caption text-subtle">
              {channel.viewerRole === "guest" || channel.joinRole === "guest"
                ? "Viewing only. Ask an owner or admin to participate."
                : channel.joinRole === "member"
                  ? "New people can participate. People already in the channel keep their access."
                  : "New people’s access could not be confirmed."}
            </p>
          </div>
        </div>
      </section>
    );
  return (
    <ChannelGeneralAccessEditor
      capability={capability}
      recovery={recovery}
      channelId={channelId}
      communityAvatar={communityAvatar}
    />
  );
}

function ChannelGeneralAccessEditor({
  capability,
  recovery,
  channelId,
  communityAvatar,
}: {
  capability: ChannelDetailsCapability;
  recovery: RelayRecovery | undefined;
  channelId: string;
  communityAvatar: (size: "compact" | "default") => ReactNode;
}) {
  const attempt = useSyncExternalStore(capability.subscribe, () =>
    capability.snapshot(channelId),
  );
  const [base, setBase] = useState<ChannelDetails>();
  const [choice, setChoice] = useState<ChannelDetailsDraft>();
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const lifetime = useRef<AbortController | undefined>(undefined);
  const busy = useRef(false);
  const origin = useRef<HTMLElement | null>(null);
  const section = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const reauthorized = useReauthorizedRetry(recovery, () => {
    const signal = lifetime.current?.signal;
    if (signal && !signal.aborted) void load(signal);
  });
  const load = useCallback(
    async (signal: AbortSignal) => {
      const failed = reauthorized.begin();
      setLoading(true);
      setError("");
      try {
        const details = await capability.load(channelId, signal);
        if (!signal.aborted) setBase(details);
      } catch (reason) {
        if (!signal.aborted) {
          setBase(undefined);
          setError(reason instanceof Error ? reason.message : String(reason));
          failed(reason);
        }
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [capability, channelId, reauthorized],
  );
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setBase(undefined);
    setChoice(undefined);
    setPending(false);
    busy.current = false;
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const locked = loading || pending || !!attempt || !base?.canEdit;
  function choose(patch: Partial<ChannelDetailsDraft>, index: number) {
    if (locked || !base) return;
    origin.current =
      section.current?.querySelectorAll<HTMLElement>('[role="combobox"]')[
        index
      ] ?? null;
    setError("");
    setChoice({ ...base, ...patch });
  }
  async function apply(check = false) {
    const controller = lifetime.current;
    if (
      !controller ||
      busy.current ||
      (check ? attempt?.status !== "unconfirmed" : !base || !choice || locked)
    )
      return;
    busy.current = true;
    setPending(true);
    setError("");
    // The choices lock while saving; keep keyboard focus in the access region.
    origin.current = section.current;
    setChoice(undefined);
    try {
      if (check) await capability.check(channelId, controller.signal);
      else if (base && choice)
        await capability.save(base, choice, controller.signal);
      if (!controller.signal.aborted) await load(controller.signal);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!controller.signal.aborted) {
        busy.current = false;
        setPending(false);
      }
    }
  }
  return (
    <section
      ref={section}
      aria-label="General access"
      tabIndex={-1}
      aria-busy={loading || pending}
      className={styles.generalAccess}
    >
      <div className={styles.accessRow}>
        <span
          className={`${styles.accessIcon} ${styles.accessEditableIcon}`}
          aria-hidden={!pending || undefined}
          role="status"
          aria-label={pending ? "Saving access" : undefined}
        >
          {pending ? (
            <CircleNotchIcon
              size={24}
              aria-hidden="true"
              className="motion-safe:animate-spin"
            />
          ) : base?.visibility === "public" ? (
            communityAvatar("default")
          ) : (
            <Avatar
              alt=""
              fallback=""
              fallbackContent={<LockIcon size={24} />}
              shape="squircle"
            />
          )}
        </span>
        <div className={styles.accessAudience}>
          <Select
            variant="compact"
            appearance="link"
            size="sm"
            label="Who can read"
            value={base?.visibility ?? ""}
            placeholder={loading ? "Loading access…" : "Access unavailable"}
            disabled={locked}
            groups={[
              {
                label: "",
                options: [
                  {
                    value: "public",
                    label: "Public",
                    leading: communityAvatar("compact"),
                  },
                  {
                    value: "private",
                    label: "Private",
                    leading: <LockIcon size={20} />,
                  },
                ],
              },
            ]}
            onValueChange={(visibility) => {
              if (
                (visibility === "public" || visibility === "private") &&
                visibility !== base?.visibility
              )
                choose({ visibility }, 0);
            }}
          />
          <p className="text-caption text-subtle">
            {!base
              ? loading
                ? "Checking channel access…"
                : "Channel access could not be confirmed."
              : base.visibility === "public"
                ? `Anyone in the community can find and ${base.joinRole === "guest" ? "view" : "participate"}.`
                : "Only people you add can read this channel."}
          </p>
        </div>
        {base?.visibility !== "private" && (
          <div className={styles.accessRole}>
            <Select
              variant="compact"
              appearance="outlined"
              label="New people can"
              align="end"
              value={base ? (base.joinRole ?? "member") : ""}
              placeholder={loading ? "Loading access…" : "Access unavailable"}
              disabled={locked}
              groups={participationOptions}
              onValueChange={(joinRole) => {
                if (
                  (joinRole === "member" || joinRole === "guest") &&
                  joinRole !== (base?.joinRole ?? "member")
                )
                  choose({ joinRole }, 1);
              }}
            />
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="text-body-sm text-danger">
          {error}
        </p>
      )}
      {attempt?.status === "unconfirmed" ? (
        <>
          <p role="status" className="text-body-sm">
            The change may have been saved. Check its status before trying
            again. Checking never resends it.
          </p>
          <Button
            disabled={loading || pending}
            onClick={() => void apply(true)}
          >
            Check save status
          </Button>
        </>
      ) : (
        error && (
          <Button
            disabled={loading || pending}
            onClick={() => {
              if (lifetime.current) void load(lifetime.current.signal);
            }}
          >
            Reload access
          </Button>
        )
      )}
      {choice && base && (
        <AlertDialog
          title="Change general access?"
          description={
            choice.visibility !== base.visibility
              ? privacyConsequence(choice.visibility)
              : `New people will ${choice.joinRole === "guest" ? "only be able to view" : "be able to participate"}. People already in the channel keep their access.`
          }
          onClose={() => setChoice(undefined)}
          initialFocus={cancel}
          finalFocus={origin}
          actions={
            <>
              <Button ref={cancel} onClick={() => setChoice(undefined)}>
                Cancel
              </Button>
              <Button
                variant="prominent"
                disabled={locked}
                onClick={() => void apply()}
              >
                Change access
              </Button>
            </>
          }
        >
          {base.visibility === "private" && choice.visibility === "public" && (
            <Field
              label={<span className="text-caption">New people can</span>}
              nativeLabel={false}
            >
              <Select
                variant="compact"
                appearance="outlined"
                size="md"
                label="New people can"
                value={choice.joinRole ?? "member"}
                disabled={locked}
                groups={participationOptions}
                onValueChange={(joinRole) => {
                  if (joinRole === "member" || joinRole === "guest")
                    setChoice((current) => current && { ...current, joinRole });
                }}
              />
            </Field>
          )}
        </AlertDialog>
      )}
    </section>
  );
}

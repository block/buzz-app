import type { IdentityNameView } from "../identity-names/service";
import { useIdentityNames } from "../identity-names/react";
import {
  PopoverClose,
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
  PopoverTitle,
} from "../../shared/design-system/ui/Popover";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import referenceStyles from "../../shared/InlineReference.module.css";
import { Fragment, memo, useRef, type RefObject } from "react";
import { profileTarget } from "../profiles/target";
import type { Profile } from "../relay/contracts";
import { membershipDescription, type TimelineRow } from "./membership-rows";
import { DayDivider } from "./MessageTimestamp";
import styles from "./Messages.module.css";
import { avatarMedia } from "../../shared/avatar-source";

type ProfileLinks = {
  viewer?: string | undefined;
  agentPubkeys?: ReadonlySet<string> | undefined;
  onOpenLink?: ((url: string) => boolean) | undefined;
  canOpenLink?: ((target: string) => boolean) | undefined;
};

/** A member's name as a button that opens their profile, or undefined where
 * the host cannot open it. A system notice names people as quiet text, not
 * mention chips. No profile target, so copies stay plain prose. */
function profileName(
  { viewer, agentPubkeys, onOpenLink, canOpenLink }: ProfileLinks,
  id: string | undefined,
  text: string,
  /** Where the profile returns focus; the name itself unless given. */
  origin?: RefObject<HTMLElement | null>,
) {
  const agent = !!id && !!agentPubkeys?.has(id);
  const target = id && profileTarget(id, { agent });
  if (!target || !canOpenLink?.(target)) return undefined;
  return (
    <button
      type="button"
      className={`${referenceStyles.link} ${styles.membershipName}`}
      aria-label={id === viewer ? "View your profile" : `View ${text} profile`}
      onClick={(event) => {
        // WebKit skips focusing buttons on pointer click, so the profile
        // tab's close would have no origin to return to.
        (origin?.current ?? event.currentTarget).focus();
        onOpenLink?.(target);
      }}
    >
      {text}
    </button>
  );
}

/** "N others": every named member, each opening their profile. */
function MembershipPreview({
  text,
  label,
  members,
  links,
}: {
  text: string;
  label: string;
  members: readonly { id: string; name: string }[];
  links: ProfileLinks;
}) {
  // A chosen name closes with the list, so its profile returns focus here.
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <PopoverRoot>
      <PopoverTrigger
        ref={trigger}
        openOnHover="preview"
        render={
          <button
            type="button"
            title=""
            className={`${referenceStyles.link} ${styles.membershipName}`}
          >
            {text}
          </button>
        }
      />
      <PopoverPopup side="top" align="center" size="compact">
        <PopoverTitle>
          {label} ({members.length})
        </PopoverTitle>
        <section
          className={styles.membershipPeople}
          aria-label={label}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded member list needs keyboard focus for native scrolling.
          tabIndex={0}
        >
          <MembershipPeople members={members} links={links} trigger={trigger} />
        </section>
      </PopoverPopup>
    </PopoverRoot>
  );
}

/** The listed names. The portal mounts this only while the list is open, so a
 * large burst resolves each member's profile target only when someone looks. */
function MembershipPeople({
  members,
  links,
  trigger,
}: {
  members: readonly { id: string; name: string }[];
  links: ProfileLinks;
  trigger: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <ul>
      {members.map((member) => {
        const name = profileName(links, member.id, member.name, trigger);
        return (
          <li key={member.id}>
            {name ? <PopoverClose render={name} /> : member.name}
          </li>
        );
      })}
    </ul>
  );
}

/** Quiet, non-conversational activity. Avatars are decorative; prose owns the
 * label, and each named member opens their profile like a prose mention. */
export const MembershipRow = memo(function MembershipRow({
  row,
  names,
  profiles,
  viewer,
  media,
  agentPubkeys,
  day,
  resolveName: scopedName,
  onOpenLink,
  canOpenLink,
}: {
  row: TimelineRow;
  names?: IdentityNameView | undefined;
  profiles: ReadonlyMap<string, Profile>;
  media(url: string, size?: "small"): string | undefined;
  day: boolean;
  resolveName?: (pubkey: string, fallback: string) => string;
} & ProfileLinks) {
  const globalName = useIdentityNames(names);
  const resolveName = scopedName ?? globalName;
  const { targets, parts, title } = membershipDescription(
    row.membershipRows ?? [row],
    profiles,
    viewer,
    resolveName,
  );
  const links = { viewer, agentPubkeys, onOpenLink, canOpenLink };
  return (
    <div data-message-id={row.id} data-membership-row="">
      {day && <DayDivider createdAt={row.createdAt} />}
      <div className={styles.membership} data-highlight-surface="">
        <span className={styles.membershipAvatars} aria-hidden="true">
          {targets.slice(0, 3).map((id) => {
            const profile = profiles.get(id);
            const name = resolveName(id, profile?.name ?? id.slice(0, 10));
            const picture = avatarMedia(profile?.picture, media);
            return (
              <span
                className={styles.membershipAvatar}
                data-avatar-shape={
                  agentPubkeys?.has(id) ? "squircle" : "circle"
                }
                key={id}
              >
                <Avatar
                  src={picture}
                  alt=""
                  fallback={name}
                  size="fill"
                  shape={agentPubkeys?.has(id) ? "squircle" : "circle"}
                />
              </span>
            );
          })}
          {targets.length > 3 && (
            <span className={styles.membershipAvatarCount}>
              +{targets.length - 3}
            </span>
          )}
        </span>
        <p title={title}>
          {parts.map((part, index) => {
            const key = `${index}:${part.id ?? ""}:${part.text}`;
            if (part.preview)
              return (
                <MembershipPreview
                  key={key}
                  text={part.text}
                  {...part.preview}
                  links={links}
                />
              );
            return (
              <Fragment key={key}>
                {profileName(links, part.id, part.text) ?? part.text}
              </Fragment>
            );
          })}
        </p>
      </div>
    </div>
  );
});

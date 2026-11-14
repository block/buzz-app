import { memo } from "react";
import type { Recipient } from "./usePeople";
import type { RelaySession } from "../relay/session";
import { MatchedLabel } from "../search/MatchedLabel";
import { matchPerson } from "../search/person-match";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { avatarMedia } from "../../shared/avatar-source";
import styles from "./NewMessage.module.css";

/** Hover changes two rows; the other avatars and labels keep their render. */
export const RecipientOption = memo(function RecipientOption({
  person,
  id,
  active,
  discriminator,
  verified,
  query,
  media,
  position,
  count,
}: {
  person: Recipient;
  id: string;
  active: boolean;
  discriminator: string | undefined;
  /** The verified full name and handle, never an editable profile name. */
  verified: string | undefined;
  query: string;
  media: RelaySession["media"];
  position: number;
  count: number;
}) {
  return (
    <NavigationItem
      id={id}
      data-recipient-key={person.pubkey}
      variant="option"
      role="option"
      aria-posinset={position}
      aria-setsize={count}
      aria-label={`${[person.name, discriminator].filter(Boolean).join(" ")}${verified ? `, ${verified}` : ""}${person.isAgent ? ", Agent" : ""}`}
      tabIndex={-1}
      selected={active}
      aria-selected={active}
      aria-current={false}
      icon={
        <Avatar
          alt=""
          fallback={person.name}
          src={avatarMedia(person.picture, media)}
          size="default"
          shape={person.isAgent ? "squircle" : "circle"}
        />
      }
      label={
        // The verified detail sits below the name, as in mentions, so a long
        // full name never squeezes the name it identifies.
        <span className="flex flex-col whitespace-normal">
          <span>
            <MatchedLabel
              label={person.name}
              positions={
                query ? matchPerson(person.name, query)?.positions : undefined
              }
            />
          </span>
          {verified && <small className={styles.agent}>{verified}</small>}
        </span>
      }
      trailing={
        discriminator || person.isAgent ? (
          <span className={styles.agent}>
            {[discriminator, person.isAgent ? "Agent" : ""]
              .filter(Boolean)
              .join(" · ")}
          </span>
        ) : undefined
      }
      onMouseDown={(event) => event.preventDefault()}
    />
  );
});

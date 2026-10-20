import { useState, type ComponentProps, type Ref } from "react";
import { CaretDownIcon } from "../../shared/design-system/icons";
import { SurfaceButton } from "../../shared/design-system/ui/SurfaceButton";
import { Button } from "../../shared/design-system/ui/Button";
import { agentAvatars } from "../../features/agents/avatar-packs";
import type { PortableAgent } from "../../features/agents/native";
import { useAvatarPreview } from "../../features/profiles/use-avatar-preview";
import styles from "./AgentCard.module.css";

const artwork = [
  "gloopies-3",
  "fuzzies-1",
  "pollies-23",
  "gloopies-20",
  "pollies-25",
  "fuzzies-4",
  "pollies-24",
  "fuzzies-18",
];
/** The most agents a crew tile scatters; its CSS places each one. */
const CREW = 12;

/** One agent the owner knows, floating on a crew tile: its picture when it
 * loads, and always its name. */
function CrewMember({ agent }: { agent: PortableAgent }) {
  const pack = agentAvatars.find((avatar) => avatar.url === agent.picture);
  const src = useAvatarPreview(
    pack ? "" : (agent.picture ?? ""),
    agent.relay || undefined,
    "small",
  );
  const [failed, setFailed] = useState(false);
  const picture = pack?.preview ?? src;
  return (
    <span className={styles.crewMember}>
      {picture && !failed && (
        <img src={picture} alt="" onError={() => setFailed(true)} />
      )}
      <span className="text-caption">{agent.name}</span>
    </span>
  );
}
export function NewAgentTile({
  fullWidth = false,
  variant = "tile",
  labelRef,
  label = "New agent",
  art = artwork,
  crew,
  description,
  secondary = false,
  ...props
}: Omit<ComponentProps<typeof SurfaceButton>, "className" | "children"> & {
  /** What the tile makes, such as New team. */
  label?: string;
  fullWidth?: boolean;
  variant?: "tile" | "button";
  labelRef?: Ref<HTMLSpanElement>;
  /** Pack avatars scattered behind a tile that is not full width. */
  art?: readonly string[];
  /** Agents the tile is about, shown by picture and name in place of art. */
  crew?: readonly PortableAgent[];
  /** A line above the label. */
  description?: string;
  /** A quieter label, for a tile beside a more important one. */
  secondary?: boolean;
}) {
  if (variant === "button")
    return (
      <Button {...props} type="button" variant="prominent" size="sm">
        {label}
        <CaretDownIcon
          size={14}
          className="buzz-dropdown-chevron"
          aria-hidden="true"
        />
      </Button>
    );
  return (
    <SurfaceButton
      {...props}
      type="button"
      className={styles.newTile}
      data-full-width={fullWidth || undefined}
      data-crew={crew ? "" : undefined}
    >
      {crew ? (
        <span aria-hidden="true" className={styles.crewArtwork}>
          {crew.slice(0, CREW).map((agent) => (
            <CrewMember key={agent.pubkey} agent={agent} />
          ))}
        </span>
      ) : (
        <span aria-hidden="true" className={styles.newArtwork}>
          {(fullWidth
            ? agentAvatars
                .filter(
                  (_, index) =>
                    index %
                      Math.max(1, Math.floor(agentAvatars.length / 12)) ===
                    0,
                )
                .slice(0, 12)
                .map((avatar) => avatar.id)
            : art
          ).flatMap((id) => {
            const avatar = agentAvatars.find((item) => item.id === id);
            return avatar?.preview
              ? [<img key={id} src={avatar.preview} alt="" />]
              : [];
          })}
        </span>
      )}
      {description && (
        <span className="text-body text-secondary">{description}</span>
      )}
      <span
        ref={labelRef}
        className={`${styles.newLabel} text-label-sm`}
        data-tone={secondary ? "secondary" : undefined}
      >
        {label}
      </span>
    </SurfaceButton>
  );
}

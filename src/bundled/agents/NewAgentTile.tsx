import type { ComponentProps, Ref } from "react";
import { CaretDownIcon } from "../../shared/design-system/icons";
import { SurfaceButton } from "../../shared/design-system/ui/SurfaceButton";
import { Button } from "../../shared/design-system/ui/Button";
import { agentAvatars } from "../../features/agents/avatar-packs";
import type { PortableAgent } from "../../features/agents/native";
import { AgentPortrait } from "./AgentCard";
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
/** The most agents a crew shows before counting the rest. */
const CREW = 6;
export function NewAgentTile({
  fullWidth = false,
  variant = "tile",
  labelRef,
  label = "New agent",
  art = artwork,
  crew,
  description,
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
        <span aria-hidden="true" className={styles.crewRow}>
          {crew.slice(0, CREW).map((agent) => (
            <span key={agent.pubkey} className={styles.crewMember}>
              {agent.picture && (
                <span className={styles.crewMemberPortrait}>
                  <AgentPortrait
                    agent={agent}
                    community={agent.relay || undefined}
                  />
                </span>
              )}
              <span className={`${styles.crewMemberName} text-caption`}>
                {agent.name}
              </span>
            </span>
          ))}
          {crew.length > CREW && (
            <span className={`${styles.crewMore} text-caption`}>
              +{crew.length - CREW}
            </span>
          )}
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
      <span ref={labelRef} className={`${styles.newLabel} text-label-sm`}>
        {label}
      </span>
    </SurfaceButton>
  );
}

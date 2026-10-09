import { agentAvatars } from "../../features/agents/avatar-packs";

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
export function NewAgentTile({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className="agent-new-tile"
      aria-haspopup="dialog"
      disabled={disabled}
      onClick={onClick}
    >
      <span aria-hidden="true" className="agent-new-artwork">
        {artwork.flatMap((id) => {
          const avatar = agentAvatars.find((item) => item.id === id);
          return avatar?.preview
            ? [<img key={id} src={avatar.preview} alt="" />]
            : [];
        })}
      </span>
      <span className="agent-new-label text-label-sm">New agent</span>
    </button>
  );
}

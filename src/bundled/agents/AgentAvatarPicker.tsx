import { AvatarEditor } from "../../features/profiles/AvatarEditor";
import { useState } from "react";
import { agentAvatars, avatarPacks } from "../../features/agents/avatar-packs";
import { Button } from "../../shared/design-system/ui/Button";

export function AgentAvatarPicker({
  value,
  disabled,
  onChange,
  name = "",
  community,
  onBusyChange,
}: {
  value?: string | undefined;
  name?: string;
  community?: string | undefined;
  onBusyChange?: ((busy: boolean) => void) | undefined;
  disabled: boolean;
  onChange(picture: string): void;
}) {
  const [pack, setPack] = useState("gloopies");
  return (
    <fieldset
      disabled={disabled}
      className="agent-avatar-picker"
      aria-label="Avatar"
    >
      <fieldset
        className="m-0 flex flex-wrap gap-2 border-0 p-0"
        aria-label="Avatar collections"
      >
        {avatarPacks.map((collection) => (
          <Button
            key={collection.id}
            size="compact"
            aria-pressed={pack === collection.id}
            onClick={() => setPack(collection.id)}
          >
            {collection.label}
          </Button>
        ))}
        <AvatarEditor
          triggerLabel="Use image"
          value={value ?? ""}
          name={name}
          community={community}
          disabled={disabled}
          onChange={onChange}
          onBusyChange={onBusyChange}
        />
      </fieldset>
      <fieldset
        className="agent-avatar-options"
        aria-label={
          avatarPacks.find((collection) => collection.id === pack)?.label
        }
      >
        {agentAvatars
          .filter((avatar) => avatar.collectionId === pack)
          .map((avatar) => (
            <button
              key={avatar.id}
              type="button"
              className="agent-avatar-option"
              aria-label={avatar.label}
              aria-pressed={value === avatar.url}
              onClick={() => onChange(avatar.url)}
            >
              <img
                src={avatar.preview}
                alt=""
                loading="lazy"
                width={64}
                height={64}
              />
            </button>
          ))}
      </fieldset>
    </fieldset>
  );
}

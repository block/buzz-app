import { Button } from "../../shared/design-system/ui/Button";
import { CircleIcon } from "../../shared/design-system/icons";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
} from "../../shared/design-system/ui/Menu";

export function AttentionStatus({
  name,
  active,
  pending,
  onChange,
}: {
  name: string;
  active: boolean;
  pending: boolean;
  onChange(active: boolean): void;
}) {
  return (
    <MenuRoot>
      <MenuTrigger
        render={
          <Button
            variant="subtle"
            size="xs"
            aria-label={`Attention status for ${name}`}
          >
            <CircleIcon
              size={12}
              fill="currentColor"
              strokeWidth={0}
              aria-hidden="true"
              style={{
                color: active
                  ? "var(--affordance-accent-prominent)"
                  : "var(--text-subtle)",
              }}
            />
            {active ? "Active" : "Paused"}
          </Button>
        }
      />
      <MenuPopup
        size="compact"
        align="end"
        aria-label={`Attention status for ${name}`}
      >
        {[true, false].map((enabled) => (
          <MenuItem
            key={String(enabled)}
            disabled={pending || active === enabled}
            closeOnClick={false}
            onClick={() => onChange(enabled)}
          >
            {enabled ? "Activate" : "Pause"}
          </MenuItem>
        ))}
      </MenuPopup>
    </MenuRoot>
  );
}

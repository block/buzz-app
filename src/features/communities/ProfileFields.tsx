import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import type { PersonalProfile } from "./service";
import { PROFILE_ABOUT_MAX_LENGTH } from "./service";
import { Textarea } from "../../shared/design-system/ui/Textarea";

export function canSaveProfile(profile: PersonalProfile) {
  return (
    !!profile.name.trim() &&
    (!profile.picture || profile.picture.startsWith("https://"))
  );
}

export function ProfileFields({
  profile,
  onChange,
  disabled = false,
}: {
  profile: PersonalProfile;
  onChange(profile: PersonalProfile): void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-4">
      <Field label="Display name">
        <Input
          autoComplete="nickname"
          required
          disabled={disabled}
          value={profile.name}
          maxLength={100}
          onChange={(event) =>
            onChange({ ...profile, name: event.target.value })
          }
        />
      </Field>
      <Field
        label="Profile description (optional)"
        description={`${profile.about?.length ?? 0} of ${PROFILE_ABOUT_MAX_LENGTH} characters`}
      >
        <Textarea
          rows={3}
          disabled={disabled}
          value={profile.about ?? ""}
          maxLength={PROFILE_ABOUT_MAX_LENGTH}
          onChange={(event) =>
            onChange({ ...profile, about: event.target.value })
          }
        />
      </Field>
      <Field label="Picture URL (optional)">
        <Input
          type="url"
          placeholder="https://…"
          disabled={disabled}
          value={profile.picture}
          maxLength={2048}
          onChange={(event) =>
            onChange({ ...profile, picture: event.target.value })
          }
        />
      </Field>
    </div>
  );
}

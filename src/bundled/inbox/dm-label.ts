import { formatPublicKey } from "../../shared/identity/public-key";

/** One label recipe for Inbox rows, details and Drafts; callers own profile reads. */
export function dmLabel(
  participants: readonly string[] | undefined,
  profiles: ReadonlyMap<string, { name?: string | undefined }>,
  resolve: (
    key: string,
    fallback: string,
    candidates?: readonly string[],
  ) => string,
  missing = "Notes to self",
) {
  if (!participants) return missing;
  if (!participants.length) return "Notes to self";
  return (
    participants
      .slice(0, 3)
      .map((key) =>
        resolve(
          key,
          profiles.get(key)?.name ?? formatPublicKey(key) ?? "Unknown person",
          participants,
        ),
      )
      .join(", ") +
    (participants.length > 3 ? ` +${participants.length - 3}` : "")
  );
}

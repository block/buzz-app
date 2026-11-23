type Visibility = "private" | "public";

export function privacyConsequence(visibility: Visibility) {
  return visibility === "private"
    ? "Only channel members will have access."
    : "Everyone in this community will be able to view this channel’s full history.";
}

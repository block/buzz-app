export type RecentStatus = Readonly<{ text: string; emoji: string }>;

const LIMIT = 2;
const key = (scope: string) => `buzz.recent-statuses.v1:${scope}`;

/** This device's last custom statuses for one community and viewer, newest first. */
export function recentStatuses(scope: string): RecentStatus[] {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(key(scope)) ?? "[]",
    );
    if (!Array.isArray(stored)) return [];
    return stored
      .filter(
        (entry): entry is RecentStatus =>
          typeof entry?.text === "string" &&
          typeof entry?.emoji === "string" &&
          !!entry.text.trim(),
      )
      .slice(0, LIMIT)
      .map(({ text, emoji }) => ({ text, emoji }));
  } catch {
    return [];
  }
}

export function rememberStatus(scope: string, status: RecentStatus) {
  const text = status.text.trim();
  const emoji = status.emoji.trim();
  // A row needs a label; emoji-only statuses are not offered again.
  if (!text) return;
  const next = [
    { text, emoji },
    ...recentStatuses(scope).filter(
      (entry) => entry.text !== text || entry.emoji !== emoji,
    ),
  ].slice(0, LIMIT);
  try {
    localStorage.setItem(key(scope), JSON.stringify(next));
  } catch {
    // Best effort; the status itself is already saved.
  }
}

export function forgetRecentStatuses(scope: string) {
  localStorage.removeItem(key(scope));
}

export const USER_STATUS_KIND = 30315;
export const STATUS_TEXT_LIMIT = 100;

/** Wire limits use UTF-16 units. Callers own trimming and optional-tag policy. */
export function validStatusText(text: string, emoji: string): boolean {
  return (
    text.length <= STATUS_TEXT_LIMIT &&
    emoji.length <= STATUS_TEXT_LIMIT &&
    !/[\r\n]/.test(text + emoji)
  );
}

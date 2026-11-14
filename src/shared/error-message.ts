/** A thrown value's message for people to read. It never starts with a
 * JavaScript error name ("Error: …", "TypeError: …"), even when an earlier
 * caller already stringified one or several errors into it, and anything
 * without readable text becomes `fallback`. */
export function errorMessage(
  error: unknown,
  fallback = "Something went wrong. Try again.",
): string {
  const text =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : typeof (error as { message?: unknown } | null)?.message === "string"
          ? (error as { message: string }).message
          : "";
  return text.replace(/^(?:\s*(?:[A-Z]\w*)?Error:)+\s*/, "").trim() || fallback;
}

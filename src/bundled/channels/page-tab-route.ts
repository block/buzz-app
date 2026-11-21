import type { JsonValue } from "../../features/navigation/targets";

/** A page visit that shows one of its host tabs, with the message it opened
 * at. A page opts in by accepting these route params; its tabs then take
 * visits that Back and Forward return to. */
export type PageTabRoute = Readonly<{ tab: string; message?: string }>;

const hex = /^[a-f0-9]{64}$/i;

/** The tab visit these route params name, if they name nothing else. */
export function pageTabRoute(
  params: JsonValue | undefined,
): PageTabRoute | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  const { tab, message, ...rest } = params as {
    readonly [key: string]: JsonValue;
  };
  if (
    Object.keys(rest).length ||
    typeof tab !== "string" ||
    !tab ||
    tab.length > 1024 ||
    (message !== undefined &&
      (typeof message !== "string" || !hex.test(message)))
  )
    return;
  return message === undefined ? { tab } : { tab, message };
}

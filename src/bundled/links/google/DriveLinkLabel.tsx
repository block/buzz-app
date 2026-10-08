import { useEffect, useSyncExternalStore } from "react";
import { LinkLabel } from "../InlineLink";
import type { DriveTitles } from "./drive";

/** The signed-in account's file name stands in for the raw destination. */
export function DriveLinkLabel({
  titles,
  url,
}: {
  titles: DriveTitles;
  url: string;
}) {
  const title = useSyncExternalStore(
    titles.subscribe,
    () => titles.title(url),
    () => titles.title(url),
  );
  useEffect(() => {
    titles.ensure(url);
    return titles.subscribe(() => titles.ensure(url));
  }, [titles, url]);
  return <LinkLabel href={url} label={title ?? url} />;
}

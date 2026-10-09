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
    // Request once per mount and again per account change, never per resolved
    // name: a bounded cache evicting under load must not refetch in a loop.
    let revision = titles.revision();
    titles.ensure(url);
    return titles.subscribe(() => {
      if (titles.revision() === revision) return;
      revision = titles.revision();
      titles.ensure(url);
    });
  }, [titles, url]);
  return <LinkLabel href={url} label={title ?? url} />;
}

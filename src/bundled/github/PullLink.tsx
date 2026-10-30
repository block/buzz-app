import {
  useCallback,
  useContext,
  useEffect,
  useSyncExternalStore,
} from "react";
import {
  LinkDescriptionContext,
  LinkInteractiveContext,
  LinkLabelContext,
} from "../../features/conversation/LinkLabelContext";
import { LinkLabel } from "../links/InlineLink";
import inlineStyles from "../../shared/InlineReference.module.css";
import { describePull, stateIcons } from "./pull-state-view";
import type { PullStates } from "./pull-states";
import { parseGitHubReference } from "./references";
import styles from "./GitHub.module.css";

/** A pull request link in a message: the Links label with the pull request's
 * state as its icon, in place of the GitHub logo, and a pasted link named by
 * its repository, number and title. */
export function PullLink({ url, states }: { url: string; states: PullStates }) {
  const identity =
    parseGitHubReference(url, { pullSubtargets: true })?.url ?? url;
  // A composer decoration or preview shows what is already known and reads
  // nothing: typing a link mounts one for every prefix of its number.
  const live = useContext(LinkInteractiveContext);
  const subscribe = useCallback(
    (listener: () => void) =>
      live ? states.watch(identity, listener) : () => {},
    [live, states, identity],
  );
  const read = useSyncExternalStore(subscribe, () => states.get(identity));
  const state = typeof read === "object" ? read : undefined;
  // The plain pull request glyph until read, and when it can't be, so the
  // icon doesn't swap when the state arrives.
  const Icon = stateIcons[state?.state ?? "open"];
  const words = describePull({ state, failed: read === "failed" });
  // The state describes the link rather than joining its name, which stays
  // the authored label as the state changes.
  const describe = useContext(LinkDescriptionContext);
  useEffect(() => {
    describe?.(words);
    return () => describe?.(undefined);
  }, [describe, words]);
  // A pasted link is named `owner/repo#7`, then with its title, which is
  // read with the state.
  const authored = useContext(LinkLabelContext) !== undefined;
  const reference = parseGitHubReference(url);
  const name = reference && `${reference.repository}${reference.label}`;
  const label = name && state?.title ? `${name} · ${state.title}` : name;
  return (
    <LinkLabel
      href={url}
      {...(!authored && label && { label })}
      icon={
        <span
          className={styles.pullState}
          data-pr-state={state?.state ?? "unknown"}
          aria-hidden="true"
          title={words}
        >
          <Icon aria-hidden="true" className={inlineStyles.icon} />
        </span>
      }
    />
  );
}

// TypeSafe as a decision provider: the user's own TypeSafe key for each
// community, kept and sent by native code. Settings > Decisions API shows
// each community's key form in its row.
import { communityDestination } from "../../features/communities/destination";
import type { DecisionProvider } from "../../features/decisions/service";
import type { PluginModule } from "../../plugins/api";
import {
  type JoinedCommunities,
  nativeTypeSafe,
  TypeSafeKeys,
  type TypeSafeNative,
} from "./key";
import { TypeSafeSettings } from "./TypeSafeSettings";

export const inject = ["decisions", "communityReader"];

/** The provider that answers with each community's key in `typesafe`. */
export const typesafeProvider = (typesafe: TypeSafeKeys): DecisionProvider => ({
  id: "typesafe",
  label: "TypeSafe",
  description: "Use your own TypeSafe API key.",
  status: typesafe.status,
  subscribe: typesafe.subscribe,
  decide: typesafe.decide,
  Settings: ({ active, grouped, community }) =>
    community === undefined ? (
      <p role="status" className="m-0 text-body-sm text-secondary">
        Join a community to add its TypeSafe API key.
      </p>
    ) : (
      <TypeSafeSettings
        typesafe={typesafe.for(community)}
        active={active}
        grouped={grouped ?? true}
      />
    ),
});

/** The joined communities from `reader`, as relay URLs. */
export const joinedCommunities = (reader: {
  snapshot(): {
    status: string;
    memberships: readonly { id: string }[];
  };
  subscribe(listener: () => void): () => void;
}): JoinedCommunities => ({
  joined: () => {
    const { status, memberships } = reader.snapshot();
    if (status === "loading") return undefined;
    return memberships.flatMap(({ id }) => {
      try {
        return [communityDestination(id).url];
      } catch {
        return [];
      }
    });
  },
  subscribe: reader.subscribe,
});

export function createApply(
  native: () => TypeSafeNative | undefined = nativeTypeSafe,
): PluginModule["apply"] {
  return (ctx) => {
    const typesafe = new TypeSafeKeys(
      native(),
      joinedCommunities(ctx.communityReader),
    );
    typesafe.load();
    ctx.decisions.registerProvider(typesafeProvider(typesafe));
  };
}
export const apply = createApply();

import { useState } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import type { RestrictionDto } from "../../features/relay-staff/contract";
import { describe, usePages, useSession } from "./session";
import { Failure, Loading, shortKey, UNSUPPORTED_BROWSING } from "./ui";

type Lift = { pubkey: string; kind: "ban" | "timeout" };

function active(row: RestrictionDto, now = new Date()) {
  return {
    banned:
      row.banned &&
      (row.banExpiresAt === null || new Date(row.banExpiresAt) > now),
    timedOut: row.mutedUntil !== null && new Date(row.mutedUntil) > now,
  };
}

export function Restrictions({ communityHost }: { communityHost: string }) {
  const { context, canMutate, request } = useSession();
  const pages = usePages(
    (cursor) => ({
      route: "listRestrictions",
      communityHost,
      ...(cursor ? { cursor } : {}),
    }),
    [context, communityHost],
  );
  const [lifting, setLifting] = useState<Lift | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState("");

  const lift = async ({ pubkey, kind }: Lift) => {
    setLifting(null);
    setError("");
    setWorking(pubkey);
    const outcome = await request({
      route: "liftRestriction",
      communityHost,
      kind,
      pubkey,
    });
    setWorking(null);
    // A conflict means someone else already changed it: show the current list.
    if (outcome.ok || outcome.failure.status === 409) pages.restart();
    else setError(describe(outcome.failure));
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-caption font-medium text-secondary">
        Active restrictions
      </p>
      {pages.failure && (
        <Failure
          failure={pages.failure}
          unsupportedText={UNSUPPORTED_BROWSING}
        />
      )}
      {error && (
        <p className="text-body-sm text-danger" role="alert">
          {error}
        </p>
      )}
      {!pages.loading && !pages.failure && pages.items.length === 0 && (
        <p className="text-body-sm text-secondary">
          No active bans or timeouts.
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {pages.items.map((row) => {
          const { banned, timedOut } = active(row);
          return (
            <li
              key={row.pubkey}
              className="flex items-center gap-2 rounded-md border px-3 py-2 text-body-sm"
            >
              <span className="flex-1 truncate font-mono" title={row.pubkey}>
                {shortKey(row.pubkey)}
              </span>
              {banned && (
                <span className="text-caption text-danger">banned</span>
              )}
              {timedOut && (
                <span className="text-caption text-secondary">timeout</span>
              )}
              {banned && (
                <Button
                  size="sm"
                  disabled={!canMutate}
                  loading={working === row.pubkey}
                  onClick={() =>
                    setLifting({ pubkey: row.pubkey, kind: "ban" })
                  }
                >
                  Lift ban
                </Button>
              )}
              {timedOut && (
                <Button
                  size="sm"
                  disabled={!canMutate}
                  loading={working === row.pubkey}
                  onClick={() =>
                    setLifting({ pubkey: row.pubkey, kind: "timeout" })
                  }
                >
                  Clear timeout
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {pages.loading && <Loading />}
      {pages.next && !pages.loading && (
        <Button size="sm" onClick={pages.more}>
          Load more
        </Button>
      )}
      {lifting && (
        <AlertDialog
          title={lifting.kind === "ban" ? "Lift ban?" : "Clear timeout?"}
          description={`${shortKey(lifting.pubkey)} will be able to post in ${communityHost} again.`}
          onClose={() => setLifting(null)}
          actions={
            <>
              <Button onClick={() => setLifting(null)}>Cancel</Button>
              <Button variant="prominent" onClick={() => void lift(lifting)}>
                {lifting.kind === "ban" ? "Lift ban" : "Clear timeout"}
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}

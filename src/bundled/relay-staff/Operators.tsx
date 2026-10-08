import { useState } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import type {
  OperatorDto,
  StaffRequest,
  StaffRole,
  StaffRoleSource,
} from "../../features/relay-staff/contract";
import { describe, useRead, useSession, useWrite } from "./session";
import { containsSecretKey, Loaded, publicKeyInput, shortKey } from "./ui";

type OperatorWrite = Extract<
  StaffRequest,
  { route: "putOperator" } | { route: "deleteOperator" }
>;

const SOURCES: Record<StaffRoleSource, string> = {
  config: "config",
  owner_fallback: "owner (fallback)",
  db: "db",
};
const ROLES = [
  {
    label: "",
    options: [
      { value: "moderator", label: "moderator" },
      { value: "operator", label: "operator" },
    ],
  },
];

/** Config-backed staff come from relay configuration and cannot change here. */
const configBacked = (operator: OperatorDto) =>
  operator.sources.some((source) => source !== "db");

export function Operators() {
  const { context, staff, canMutate } = useSession();
  const [list, reload] = useRead({ route: "listOperators" }, [context]);
  const [input, setInput] = useState("");
  const [role, setRole] = useState<StaffRole>("moderator");
  const [error, setError] = useState("");
  const write = useWrite<OperatorWrite>("operators");
  const working = write.busy ? (write.frozen?.pubkey ?? null) : null;
  const [removing, setRemoving] = useState<OperatorDto | null>(null);
  const pubkey = publicKeyInput(input);
  const secret = containsSecretKey(input);

  /** A change to your own entry re-checks your role. */
  const after = async (change: OperatorWrite) => {
    setError("");
    const outcome = await write.run(change);
    if (!outcome) return false;
    if (!outcome.ok) {
      setError(describe(outcome.failure));
      return false;
    }
    reload();
    if (change.pubkey === context.signer) void staff.probe(context, true);
    return true;
  };
  const add = async (operators: OperatorDto[]) => {
    if (!pubkey) return;
    const existing = operators.find((operator) => operator.pubkey === pubkey);
    if (existing)
      return setError(
        `Already staff as ${existing.effectiveRole}. Change their role on their row.`,
      );
    if (await after({ route: "putOperator", pubkey, role })) setInput("");
  };

  return (
    <Loaded read={list}>
      {(operators) => (
        <div className="flex flex-col gap-4">
          {canMutate && (
            <div className="flex flex-col gap-2 rounded-md border px-3 py-2.5">
              <p className="text-caption font-medium text-secondary">
                Add staff
              </p>
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Public key"
                  placeholder="npub or 64-hex public key"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                />
                <Select
                  label="Role"
                  variant="compact"
                  value={role}
                  groups={ROLES}
                  onValueChange={(value) => setRole(value as StaffRole)}
                />
                <Button
                  size="sm"
                  loading={working !== null && working === pubkey}
                  disabled={!pubkey}
                  onClick={() => void add(operators)}
                >
                  Add
                </Button>
              </div>
              {secret && (
                <p className="text-caption text-danger">
                  That looks like a private key. Never paste it here.
                </p>
              )}
            </div>
          )}
          {error && (
            <p className="text-body-sm text-danger" role="alert">
              {error}
            </p>
          )}
          {operators.length === 0 ? (
            <p className="text-body-sm text-secondary">No staff configured.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {operators.map((operator) => {
                const fixed = configBacked(operator);
                const name = shortKey(operator.pubkey);
                return (
                  <li
                    key={operator.pubkey}
                    className="flex items-center gap-2 rounded-md border px-3 py-2 text-body-sm"
                  >
                    <span
                      className="flex-1 truncate font-mono"
                      title={operator.pubkey}
                    >
                      {name}
                      {operator.pubkey === context.signer && " (you)"}
                    </span>
                    <span className="text-caption text-secondary">
                      {operator.sources
                        .map((source) => SOURCES[source])
                        .join(", ")}
                    </span>
                    {fixed || !canMutate ? (
                      <span className="text-caption">
                        {operator.effectiveRole}
                      </span>
                    ) : (
                      <Select
                        label={`Role for ${name}`}
                        variant="compact"
                        value={operator.effectiveRole}
                        groups={ROLES}
                        disabled={working === operator.pubkey}
                        onValueChange={(value) =>
                          value !== operator.effectiveRole &&
                          void after({
                            route: "putOperator",
                            pubkey: operator.pubkey,
                            role: value as StaffRole,
                          })
                        }
                      />
                    )}
                    {canMutate && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={fixed || working === operator.pubkey}
                        title={
                          fixed
                            ? "Set in relay configuration; cannot be removed here"
                            : undefined
                        }
                        onClick={() => setRemoving(operator)}
                      >
                        Remove
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {removing && (
            <AlertDialog
              title="Remove staff?"
              description={
                removing.pubkey === context.signer
                  ? "You are removing your own staff access. You may not be able to undo this."
                  : `${shortKey(removing.pubkey)} (${removing.effectiveRole}) loses relay staff access.`
              }
              onClose={() => setRemoving(null)}
              actions={
                <>
                  <Button onClick={() => setRemoving(null)}>Cancel</Button>
                  <Button
                    variant="destructive"
                    onClick={() => {
                      const target = removing.pubkey;
                      setRemoving(null);
                      void after({ route: "deleteOperator", pubkey: target });
                    }}
                  >
                    Remove
                  </Button>
                </>
              }
            />
          )}
        </div>
      )}
    </Loaded>
  );
}

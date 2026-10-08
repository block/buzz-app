import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { StaffRequest } from "../../features/relay-staff/contract";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { Header } from "../../shared/design-system/ui/Header";
import {
  CheckCircleIcon,
  CircleNotchIcon,
  ShieldIcon,
  WarningCircleIcon,
} from "../../shared/design-system/icons";
import { Console } from "./Console";
import { createSession, describe, SessionProvider } from "./session";
import type { Access, Staff } from "./staff";

export function RelayStaff({
  staff,
  active,
}: {
  staff: Staff;
  active(): boolean;
}) {
  useSyncExternalStore(staff.subscribe, () => staff.visible());
  const context = staff.context();
  const access = useSyncExternalStore(staff.subscribe, () =>
    context ? staff.access(context) : null,
  );
  const contextKey = context && `${context.signer} ${context.origin}`;
  // Opening the card is what sends the first signed request.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by identity and host
  useEffect(() => {
    if (context && active()) void staff.probe(context);
  }, [staff, contextKey]);

  if (!staff.backend.available)
    return (
      <EmptyState
        icon={<ShieldIcon />}
        title="Relay staff"
        description="The relay staff console needs the Buzz desktop app."
      />
    );
  if (!context) return null;
  return (
    <div className="flex flex-col gap-4">
      <Header
        title="Relay staff"
        subtitle={`Triage reports, review feedback and manage staff on ${new URL(context.origin).host}.`}
        actions={
          <Button
            size="sm"
            loading={access?.state === "probing"}
            onClick={() => void staff.probe(context, true)}
          >
            Check again
          </Button>
        }
      />
      <AccessStatus access={access} signer={context.signer} />
      {access?.state === "authorized" && (
        <Authorized key={contextKey} staff={staff} access={access} />
      )}
    </div>
  );
}

function Authorized({
  staff,
  access,
}: {
  staff: Staff;
  access: Extract<Access, { state: "authorized" }>;
}) {
  const context = staff.context();
  const frozen = useRef(new Map<string, StaffRequest>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: the panel is keyed by identity and host; only the role changes here
  const session = useMemo(
    () =>
      context && createSession(staff, context, access.probe, frozen.current),
    // The panel is keyed by identity and host; only the role can change here.
    [staff, access.probe],
  );
  if (!session) return null;
  return (
    <SessionProvider value={session}>
      <Console />
    </SessionProvider>
  );
}

function AccessStatus({
  access,
  signer,
}: {
  access: Access | null;
  signer: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!access || access.state === "probing")
    return (
      <p className="flex items-center gap-2 text-body-sm text-secondary">
        <CircleNotchIcon className="animate-spin" /> Checking your access…
      </p>
    );
  switch (access.state) {
    case "authorized": {
      const { role, authMode } = access.probe;
      if (authMode === "disabled")
        return (
          <p
            className="flex items-center gap-2 text-body-sm text-warning"
            role="status"
          >
            <WarningCircleIcon /> Admin auth is disabled on this relay. The
            console is read-only; taking action requires BUZZ_ADMIN_AUTH=nip98.
          </p>
        );
      return (
        <p
          className="flex items-center gap-2 text-body-sm text-success"
          role="status"
        >
          <CheckCircleIcon /> Connected as {role ?? "staff"}
        </p>
      );
    }
    case "denied":
      return (
        <div className="flex flex-col gap-2 text-body-sm" role="alert">
          <p className="flex items-center gap-2 text-danger">
            <WarningCircleIcon /> Access denied
          </p>
          <p className="text-secondary">
            Your public key is not on this relay's staff list. Ask a relay
            operator to add:
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all font-mono text-caption">
              {signer}
            </code>
            <Button
              size="sm"
              onClick={() =>
                void navigator.clipboard
                  .writeText(signer)
                  .then(() => setCopied(true))
              }
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      );
    case "notAdminApi":
      return (
        <p
          className="flex items-center gap-2 text-body-sm text-secondary"
          role="alert"
        >
          <WarningCircleIcon /> The admin host this relay advertises has no
          admin API.
        </p>
      );
    case "unreachable":
      return (
        <p
          className="flex items-center gap-2 text-body-sm text-danger"
          role="alert"
        >
          <WarningCircleIcon />
          {access.failure.category === "ambiguous" ||
          access.failure.category === "intercepted"
            ? "Could not reach the admin host. Check your network, TLS, DNS, or whether a VPN or SSO gateway intercepts it."
            : describe(access.failure)}
        </p>
      );
  }
}

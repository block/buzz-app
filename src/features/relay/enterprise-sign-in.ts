/** Native relay commands reject with this exact text when the enterprise
 * adapter says the session is gone (`nip_fi_assertion::SIGN_IN_REQUIRED`). */
export const ENTERPRISE_SIGN_IN_REQUIRED = "Enterprise sign-in is required";
/** The adapter refused this relay for a still-valid session
 * (`nip_fi_assertion::ACCESS_DENIED`); signing in again cannot fix it. */
export const ENTERPRISE_ACCESS_DENIED =
  "Enterprise access to this relay was denied";

/** Prefix of an adapter refusal that retrying cannot fix
 * (`nip_fi_assertion::REFUSED`); the session stays and the error is shown. */
export const ENTERPRISE_BADGE_REFUSED = "Relay badge was refused";

const listeners = new Set<() => void>();

/** Runs `listener` whenever a relay request is refused for a lost session. */
export function onEnterpriseSignInRequired(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reports `error` to sign-in listeners when it is a session denial. */
export function noteEnterpriseDenial(error: unknown) {
  const message = error instanceof Error ? error.message : error;
  if (message === ENTERPRISE_SIGN_IN_REQUIRED)
    for (const listener of listeners) listener();
}

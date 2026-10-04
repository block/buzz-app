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
let logins = 0;

/** Marks a login starting or finishing. A denial of a request made before
 * then refused a session that login has replaced, or is replacing. */
export function noteEnterpriseLogin() {
  logins++;
}

/** Captured when a relay request starts, then passed to
 * `noteEnterpriseDenial` with its result. */
export function enterpriseLoginMark() {
  return logins;
}

/** Runs `listener` whenever a relay request is refused for a lost session. */
export function onEnterpriseSignInRequired(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reports `error` to sign-in listeners when it is a session denial of a
 * request made since the last login started or finished. */
export function noteEnterpriseDenial(error: unknown, mark: number) {
  const message = error instanceof Error ? error.message : error;
  if (message === ENTERPRISE_SIGN_IN_REQUIRED && mark === logins)
    for (const listener of listeners) listener();
}

/** Native relay commands reject with this exact text when the enterprise
 * adapter says the session is gone (`nip_fi_assertion::SIGN_IN_REQUIRED`). */
export const ENTERPRISE_SIGN_IN_REQUIRED = "Enterprise sign-in is required";

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

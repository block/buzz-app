/** Claude Code's own turn errors when it cannot renew the user's sign-in. */
export function expiredSignIn(error: string | undefined) {
  return (
    !!error &&
    /^(?:Error:\s*)?(?:Failed to authenticate:\s*)?OAuth (?:session expired and could not be refreshed|token has expired)\b/i.test(
      error.trim(),
    )
  );
}

export const SIGN_IN_AGAIN =
  "Sign in again with Claude to keep using your existing setup.";

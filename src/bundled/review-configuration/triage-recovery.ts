/** Local recovery hints never authorize a send: continuation rereads the signed
 * artifact and verifies its submitter/device under the existing submission lock. */
export type TriageHint = { channel: string; artifact: string };
const listeners = new Map<string, Set<(artifact: string) => void>>();
const errors = new Map<string, string>();
const errorListeners = new Set<() => void>();
const key = (scope: string) => `buzz.review.triage:${scope}`;
export function pendingTriage(scope: string): TriageHint[] {
  const values: unknown = JSON.parse(localStorage.getItem(key(scope)) ?? "[]");
  if (
    !Array.isArray(values) ||
    values.length > 100 ||
    values.some(
      (value) =>
        !value ||
        typeof value.channel !== "string" ||
        typeof value.artifact !== "string" ||
        !/^[0-9a-f-]{36}$/.test(value.artifact),
    )
  )
    throw new Error(
      "Triage recovery storage is unreadable. Submit the PR again to inspect its saved state.",
    );
  return values;
}
export function rememberTriage(scope: string, hint: TriageHint) {
  const entries = pendingTriage(scope).filter(
    (item) => item.artifact !== hint.artifact,
  );
  if (entries.length >= 100)
    throw new Error(
      "Finish pending triage before submitting more PRs (limit 100).",
    );
  localStorage.setItem(key(scope), JSON.stringify([...entries, hint]));
  for (const listener of listeners.get(scope) ?? []) listener(hint.artifact);
}
export function forgetTriage(scope: string, artifact: string) {
  localStorage.setItem(
    key(scope),
    JSON.stringify(
      pendingTriage(scope).filter((item) => item.artifact !== artifact),
    ),
  );
  setTriageError(scope, artifact, "");
}
export function subscribeTriage(
  scope: string,
  listener: (artifact: string) => void,
) {
  const set = listeners.get(scope) ?? new Set();
  listeners.set(scope, set);
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(scope);
  };
}
export function setTriageError(
  scope: string,
  artifact: string,
  message: string,
) {
  const id = `${scope}:${artifact}`;
  if (errors.get(id) === message) return;
  if (message) errors.set(id, message);
  else errors.delete(id);
  for (const listener of errorListeners) listener();
}
export const triageError = (scope: string, artifact: string) =>
  errors.get(`${scope}:${artifact}`) ?? errors.get(`${scope}:startup`) ?? "";
export function subscribeTriageErrors(listener: () => void) {
  errorListeners.add(listener);
  return () => {
    errorListeners.delete(listener);
  };
}

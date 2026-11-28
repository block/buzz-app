const preferenceKey = "buzz-confirm-solo-delete.v1";

export function confirmSoloDeletion(): boolean {
  try {
    return localStorage.getItem(preferenceKey) !== "false";
  } catch {
    return true;
  }
}

export function setConfirmSoloDeletion(confirmed: boolean): void {
  localStorage.setItem(preferenceKey, String(confirmed));
}

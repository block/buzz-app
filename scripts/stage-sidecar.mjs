import {
  chmodSync,
  copyFileSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";

const EXECUTABLE_MODE = 0o755;

// Keeps Cargo's watched resource intact when the built executable is unchanged.
export function stageSidecar(built, destination) {
  const staged = statSync(destination, { throwIfNoEntry: false });
  if (
    staged &&
    staged.size === statSync(built).size &&
    readFileSync(destination).equals(readFileSync(built))
  ) {
    if ((staged.mode & 0o777) !== EXECUTABLE_MODE)
      chmodSync(destination, EXECUTABLE_MODE);
    return false;
  }

  const pending = `${destination}.new`;
  copyFileSync(built, pending);
  chmodSync(pending, EXECUTABLE_MODE);
  renameSync(pending, destination);
  return true;
}

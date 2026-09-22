import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { randomUUID } from "node:crypto";
import { relayOrigin } from "../src/features/communities/destination.ts";

// A remembered local choice, not membership authority or a credential store.
export function communityPreference(
  directory = join(homedir(), ".buzz", "dev-communities"),
) {
  const file = (viewer) => {
    if (!/^[a-f0-9]{64}$/.test(viewer)) throw new Error("Invalid viewer");
    return join(directory, `${viewer}.json`);
  };
  const validate = (value) => {
    if (
      !value ||
      typeof value.url !== "string" ||
      typeof value.name !== "string" ||
      value.name.length > 256 ||
      !Number.isFinite(value.selectedAt) ||
      value.selectedAt < 0
    )
      throw new Error("Invalid community preference");
    return {
      url: relayOrigin(value.url),
      name: value.name,
      selectedAt: value.selectedAt,
    };
  };
  return {
    read(viewer) {
      try {
        const raw = readFileSync(file(viewer), "utf8");
        if (raw.length > 4096) return null;
        return validate(JSON.parse(raw));
      } catch {
        return null;
      }
    },
    async write(viewer, value) {
      const destination = file(viewer);
      const preference = validate(value);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const release = await lockfile.lock(destination, {
        realpath: false,
        retries: { retries: 10, minTimeout: 10, maxTimeout: 100 },
      });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        const previous = this.read(viewer);
        if (previous && previous.selectedAt > preference.selectedAt) return;
        writeFileSync(temporary, JSON.stringify(preference), {
          mode: 0o600,
          flag: "wx",
        });
        renameSync(temporary, destination);
      } finally {
        rmSync(temporary, { force: true });
        await release();
      }
    },
  };
}

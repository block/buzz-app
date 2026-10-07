import { expect, it } from "vitest";
import { validateSnapshotFile } from "./snapshot-file";

it.each(["png", "json"])("uses agent/team limits for %s", (extension) => {
  const type = extension === "png" ? "image/png" : "application/json";
  const bytes = new Uint8Array(10 * 1024 * 1024 + 1);
  expect(() =>
    validateSnapshotFile(
      new File([bytes], `worker.agent.${extension}`, { type }),
    ),
  ).toThrow();
  expect(() =>
    validateSnapshotFile(
      new File([bytes], `worker.team.${extension}`, { type }),
    ),
  ).not.toThrow();
  expect(() =>
    validateSnapshotFile(
      new File(
        [new Uint8Array(50 * 1024 * 1024 + 1)],
        `worker.team.${extension}`,
        { type },
      ),
    ),
  ).toThrow();
});

it("rejects empty and mismatched file forms", () => {
  for (const file of [
    new File([], "empty.json", { type: "application/json" }),
    new File(["{}"], "worker.pdf", { type: "application/pdf" }),
    new File(["{}"], "worker.png", { type: "application/json" }),
  ]) {
    expect(() => validateSnapshotFile(file)).toThrow();
  }
});

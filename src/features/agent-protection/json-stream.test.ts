import { expect, it, vi } from "vitest";
import { writeJSON } from "./json-stream";

it("rejects streamed evidence before writing when the process lacks an atomic writer", async () => {
  const write = vi.fn(async (_data: string) => {});
  const read = vi.fn(async function* () {
    yield "evidence";
  });
  await expect(writeJSON({ write }, { input: { read } })).rejects.toThrow(
    "The process cannot accept streamed JSON",
  );
  expect(write).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

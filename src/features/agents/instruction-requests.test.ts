import { describe, expect, it, vi } from "vitest";
import {
  InstructionRequests,
  type InstructionAdmission,
  type InstructionReview,
} from "./instruction-requests";
import { memoryStorage, sharedFiles } from "./test-fakes";

const review = (id: string): InstructionReview => ({
  id,
  agent: "selected-agent",
  owner: "owner",
  community: "https://synthetic.example.test",
  source: "source-channel",
  plugin: "synthetic",
  operation: "synthetic/link",
  tool: "synthetic_link",
  args: { from: "A", to: "B" },
  text: "Link A to B.",
});
function admission(
  value: InstructionReview,
  deliver: InstructionAdmission["deliver"] = async () => "delivered",
) {
  return {
    review: value,
    check: vi.fn(),
    cancel: vi.fn(),
    deliver: vi.fn(deliver),
  };
}

describe("instruction reservations", () => {
  it("replays a durable receipt across restart but rejects changed owner, community or payload", async () => {
    const storage = memoryStorage();
    const first = new InstructionRequests(storage, () => {});
    const value = review(await first.id());
    const one = admission(value);
    const pending = first.submit(one);
    await vi.waitFor(() => expect(first.snapshot()).toHaveLength(1));
    const same = admission(value);
    const duplicate = first.submit(same);
    expect(first.snapshot()).toHaveLength(1);
    first.decide(value.id, true);
    await expect(pending).resolves.toEqual({
      id: value.id,
      status: "delivered",
    });
    await expect(duplicate).resolves.toEqual({
      id: value.id,
      status: "delivered",
    });
    const restarted = new InstructionRequests(storage, () => {});
    const again = admission(value);
    await expect(restarted.submit(again)).resolves.toEqual({
      id: value.id,
      status: "delivered",
    });
    expect(again.deliver).not.toHaveBeenCalled();
    const revoked = admission(value);
    revoked.check.mockImplementation(() => {
      throw new Error("revoked");
    });
    await expect(restarted.submit(revoked)).rejects.toThrow("revoked");
    expect(revoked.deliver).not.toHaveBeenCalled();
    for (const patch of [
      { owner: "another" },
      { community: "https://other.example.test" },
      { args: { from: "A", to: "C" } },
    ])
      await expect(
        restarted.submit(admission({ ...value, ...patch })),
      ).rejects.toThrow("different contents");
    expect(one.deliver).toHaveBeenCalledTimes(1);
    expect(same.deliver).not.toHaveBeenCalled();
    expect(restarted.snapshot()).toEqual([]);
  });

  it("never redelivers an interrupted reservation, including from another process", async () => {
    const files = sharedFiles();
    const first = new InstructionRequests(files.open(), () => {});
    const id = await first.id();
    const original = admission(review(id));
    const pending = first.submit(original);
    await vi.waitFor(() => expect(first.snapshot()).toHaveLength(1));
    const afterCrash = new InstructionRequests(files.open(), () => {});
    const replay = admission(review(id));
    await expect(afterCrash.submit(replay)).resolves.toEqual({
      id,
      status: "uncertain",
    });
    expect(afterCrash.snapshot()).toEqual([]);
    expect(replay.deliver).not.toHaveBeenCalled();
    first.decide(id, false);
    await expect(pending).resolves.toEqual({ id, status: "refused" });
    expect(original.deliver).not.toHaveBeenCalled();
  });

  it("preserves uncertainty if the transport result cannot be durably acknowledged", async () => {
    const storage = memoryStorage();
    const requests = new InstructionRequests(storage, () => {});
    const id = await requests.id();
    const one = admission(review(id));
    const pending = requests.submit(one);
    await vi.waitFor(() => expect(requests.snapshot()).toHaveLength(1));
    const write = vi
      .spyOn(storage, "set")
      .mockRejectedValueOnce(new Error("synthetic disk failure"));
    requests.decide(id, true);
    await expect(pending).rejects.toThrow("synthetic disk failure");
    write.mockRestore();
    const restarted = new InstructionRequests(storage, () => {});
    const retry = admission(review(id));
    await expect(restarted.submit(retry)).resolves.toEqual({
      id,
      status: "uncertain",
    });
    expect(one.deliver).toHaveBeenCalledTimes(1);
    expect(retry.deliver).not.toHaveBeenCalled();
  });

  it("refuses foreign-device IDs without requesting confirmation", async () => {
    const first = new InstructionRequests(memoryStorage(), () => {});
    const second = new InstructionRequests(memoryStorage(), () => {});
    await second.id();
    const request = admission(review(await first.id()));
    await expect(second.submit(request)).rejects.toThrow("device");
    expect(second.snapshot()).toEqual([]);
    expect(request.deliver).not.toHaveBeenCalled();
  });

  it("rechecks authorization at confirmation and does not deliver a revoked request", async () => {
    const requests = new InstructionRequests(memoryStorage(), () => {});
    const value = review(await requests.id());
    const one = admission(value);
    const pending = requests.submit(one);
    await vi.waitFor(() => expect(requests.snapshot()).toHaveLength(1));
    one.check.mockImplementation(() => {
      throw new Error("revoked");
    });
    requests.decide(value.id, true);
    await expect(pending).resolves.toEqual({ id: value.id, status: "refused" });
    expect(one.deliver).not.toHaveBeenCalled();
  });
});

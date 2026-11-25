import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { AgentKey } from "./membership";
import type { AgentStore } from "./store";
import { exactArgs, type AgentToolOperation } from "./tool-operation";

export type AgentInstructionInput = Readonly<{
  /** Keep this device-bound ID for retries; obtain it with instructionId(). */
  id: string;
  agent: AgentKey;
  source: string;
  operation: AgentToolOperation;
  tool: string;
  args: Readonly<Record<string, unknown>>;
  text: string;
}>;
export type InstructionReceipt = Readonly<{
  id: string;
  /** Delivery is transport acceptance, never completion of the operation. */
  status: "delivered" | "refused" | "uncertain";
}>;
export type InstructionReview = Readonly<{
  id: string;
  agent: string;
  owner: string;
  community: string;
  source: string;
  plugin: string;
  operation: string;
  tool: string;
  args: Readonly<Record<string, unknown>>;
  text: string;
}>;
export type InstructionAdmission = Readonly<{
  review: InstructionReview;
  check(): void;
  deliver(): Promise<"delivered" | "refused" | "uncertain">;
  cancel(): void;
}>;
const PREFIX = "buzz.agent-instructions.v1/";
const DEVICE = `${PREFIX}device`;

/** A durable reservation precedes confirmation and handoff. An interrupted
 * reservation is never replayed: the receiver may already have the input. */
export class InstructionRequests {
  private reviews: readonly InstructionReview[] = [];
  private pending = new Map<
    string,
    { admission: InstructionAdmission; settle(allowed: boolean): void }
  >();
  private active = new Map<
    string,
    { digest: string; receipt: Promise<InstructionReceipt> }
  >();
  constructor(
    private store: AgentStore,
    private changed: () => void,
  ) {}
  snapshot = () => this.reviews;
  async id() {
    const device = await this.store.add(DEVICE, crypto.randomUUID());
    return `${device}/${crypto.randomUUID()}`;
  }
  submit(admission: InstructionAdmission): Promise<InstructionReceipt> {
    const { review } = admission;
    const digest = bytesToHex(
      sha256(new TextEncoder().encode(exactArgs(review))),
    );
    const running = this.active.get(review.id);
    if (running) {
      admission.cancel();
      if (running.digest !== digest)
        return Promise.reject(
          new Error("Instruction ID has different contents"),
        );
      return running.receipt;
    }
    const receipt = this.admit(admission, digest);
    this.active.set(review.id, { digest, receipt });
    void receipt.finally(() => this.active.delete(review.id)).catch(() => {});
    return receipt;
  }
  private async admit(
    admission: InstructionAdmission,
    digest: string,
  ): Promise<InstructionReceipt> {
    const { review } = admission;
    const result = (status: InstructionReceipt["status"]) => ({
      id: review.id,
      status,
    });
    const key = `${PREFIX}request/${review.id}`;
    const nonce = crypto.randomUUID();
    const reservation = JSON.stringify({ digest, nonce, status: "uncertain" });
    try {
      const device = await this.store.read(DEVICE);
      if (
        !device ||
        !review.id.startsWith(`${device}/`) ||
        !/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(review.id)
      )
        throw new Error(
          "Instruction IDs belong to the device that created them",
        );
      admission.check();
      const held = await this.store.add(key, reservation);
      admission.check();
      if (held !== reservation) {
        const previous = JSON.parse(held) as {
          digest: string;
          status: InstructionReceipt["status"];
        };
        if (previous.digest !== digest)
          throw new Error("Instruction ID has different contents");
        return result(
          previous.status === "delivered" || previous.status === "refused"
            ? previous.status
            : "uncertain",
        );
      }
      if (this.pending.size >= 16)
        throw new Error("Too many pending instructions");
      const allowed = await new Promise<boolean>((settle) => {
        this.pending.set(review.id, { admission, settle });
        this.reviews = [...this.reviews, review];
        this.changed();
      });
      let status: InstructionReceipt["status"] = "refused";
      if (allowed) {
        admission.check();
        status = await admission.deliver();
      }
      await this.store.set(key, JSON.stringify({ digest, nonce, status }));
      return result(status);
    } finally {
      this.pending.delete(review.id);
      this.reviews = this.reviews.filter(({ id }) => id !== review.id);
      admission.cancel();
      this.changed();
    }
  }
  decide(id: string, allowed: boolean) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.reviews = this.reviews.filter((review) => review.id !== id);
    if (allowed) {
      try {
        pending.admission.check();
      } catch {
        allowed = false;
      }
    }
    pending.settle(allowed);
    this.changed();
  }
  cancel(id: string) {
    this.decide(id, false);
  }
}

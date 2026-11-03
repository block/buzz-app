import type { VerifiedProfileView } from "./types";

export type ReviewMember = Readonly<{
  pubkey: string;
  verified?: VerifiedProfileView;
  /** Shown beside the member, such as a message count. */
  note?: string;
}>;

export type ImportReview = Readonly<{
  id: string;
  type: "propose" | "consent" | "direct-message" | "channel";
  title: string;
  description: string;
  facts: readonly Readonly<{ label: string; value: string }>[];
  members: readonly ReviewMember[];
  /** A statement the person confirms by approving. */
  statement?: string;
  /** Why this request cannot be approved. The dialog then offers no approval. */
  refusal?: string;
  confirmLabel: string;
  destructive?: boolean;
}>;

const issued = new WeakSet<object>();

/** Whether `value` came from `createImportReviews`, not a lookalike. */
export function isImportReviews(value: unknown): value is ImportReviews {
  return typeof value === "object" && value !== null && issued.has(value);
}

/** The human gate for conversation import. Requests resolve only from the
 * host-mounted dialog; plugins never receive this object. */
export function createImportReviews() {
  type Pending = { review: ImportReview; resolve(approved: boolean): void };
  let queue: readonly Pending[] = [];
  let snapshot: readonly ImportReview[] = [];
  const listeners = new Set<() => void>();
  const publish = (next: readonly Pending[]) => {
    queue = next;
    snapshot = Object.freeze(next.map((item) => item.review));
    for (const listener of [...listeners]) listener();
  };
  const settle = (id: string, approved: boolean) => {
    const item = queue.find((entry) => entry.review.id === id);
    if (!item) return;
    publish(queue.filter((entry) => entry !== item));
    item.resolve(approved && !item.review.refusal);
  };
  const reviews = Object.freeze({
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Resolves true only when the person approves this exact request. */
    request(
      review: Omit<ImportReview, "id">,
      signal?: AbortSignal,
    ): Promise<boolean> {
      signal?.throwIfAborted();
      const id = crypto.randomUUID();
      return new Promise<boolean>((resolve) => {
        const abort = () => settle(id, false);
        signal?.addEventListener("abort", abort, { once: true });
        publish([
          ...queue,
          {
            review: Object.freeze({ ...review, id }),
            resolve: (approved) => {
              signal?.removeEventListener("abort", abort);
              resolve(approved);
            },
          },
        ]);
      });
    },
    approve: (id: string) => settle(id, true),
    dismiss: (id: string) => settle(id, false),
    dispose() {
      for (const item of queue) item.resolve(false);
      publish([]);
      listeners.clear();
    },
  });
  issued.add(reviews);
  return reviews;
}

export type ImportReviews = ReturnType<typeof createImportReviews>;

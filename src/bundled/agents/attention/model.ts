import type { Context } from "../../../plugins/author";
export type AttentionValue = NonNullable<
  Parameters<Context["agents"]["save"]>[1]["attention"]
>[string];

export type Agent = ReturnType<
  Context["agents"]["snapshot"]
>["running"][number] & { sourceRuns?: Readonly<Record<string, string>> };
type StoredWatch = Exclude<NonNullable<AttentionValue>, { type: "interest" }>;
export type Watch =
  | Exclude<StoredWatch, { type: "event" }>
  | (Extract<StoredWatch, { type: "event" }> & {
      keywords?: readonly string[];
    });

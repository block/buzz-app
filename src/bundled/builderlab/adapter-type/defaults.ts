import type { RemoteAgentModelCatalog } from "../agents/client";
import { oauthTarget } from "../oauth/browser";

export type ModelDefault = Readonly<{
  modelId: string;
  reasoningEffort: string;
}>;

/** Creation preferences belong to this device, Builderlab environment and account.
 * They never rewrite an existing remote agent's saved configuration. */
export class BuilderlabDefaults {
  private revision = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: Storage = localStorage) {}

  snapshot = () => this.revision;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private key(subject: string) {
    return `buzz.builderlab.model-default.v1:${JSON.stringify([oauthTarget(), subject])}`;
  }
  read(subject: string): ModelDefault | undefined {
    try {
      const value = JSON.parse(
        this.storage.getItem(this.key(subject)) ?? "null",
      );
      if (
        value &&
        typeof value.modelId === "string" &&
        value.modelId.trim() &&
        typeof value.reasoningEffort === "string" &&
        value.reasoningEffort.trim()
      )
        return {
          modelId: value.modelId,
          reasoningEffort: value.reasoningEffort,
        };
    } catch {
      // Missing/malformed preferences leave Builderlab's recommendation in charge.
    }
    return undefined;
  }
  resolve(subject: string, catalog: RemoteAgentModelCatalog) {
    const saved = this.read(subject);
    return saved &&
      catalog.models
        .find((model) => model.id === saved.modelId)
        ?.supportedReasoningEfforts.includes(saved.reasoningEffort)
      ? saved
      : catalog.recommended;
  }
  save(subject: string, value?: ModelDefault) {
    const key = this.key(subject);
    if (value) this.storage.setItem(key, JSON.stringify(value));
    else this.storage.removeItem(key);
    this.revision++;
    for (const listener of this.listeners) listener();
  }
}

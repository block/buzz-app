// FOUNDATION: Typed external-object data contributions, independent of page and panel layout.
import { Service, type Context } from "@deepseek-ai/cordis";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";

export type ExternalObjectReference = Readonly<{
  provider: string;
  key: string;
  kind: string;
  url: string;
  label: string;
  group?: string;
}>;
export type ExternalObjectDetails = Readonly<{
  reference: ExternalObjectReference;
  title: string;
  body?: string;
  state?: string;
  author?: string;
  facts: readonly (readonly [string, string | number])[];
}>;
export type ObjectProvider = Readonly<{
  id: string;
  title: string;
  identify(target: string): ExternalObjectReference | undefined;
  load(
    reference: ExternalObjectReference,
    signal: AbortSignal,
  ): Promise<ExternalObjectDetails>;
}>;
export type RegisteredObjectProvider = Contribution<ObjectProvider>;
export type ResolvedObject = Readonly<{
  provider: RegisteredObjectProvider;
  reference: ExternalObjectReference;
}>;
export type Objects = {
  register(provider: ObjectProvider): void;
  resolve(target: string): ResolvedObject | undefined;
  load(
    target: string,
    signal: AbortSignal,
  ): Promise<ExternalObjectDetails | undefined>;
  snapshot(): readonly RegisteredObjectProvider[];
  subscribe(listener: () => void): () => void;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    objects: Objects;
  }
}

export class ObjectsService extends Service implements Objects {
  private readonly providers;
  constructor(ctx: Context) {
    super(ctx, "objects");
    this.providers = createContributions<ObjectProvider>(ctx);
  }
  snapshot = () => this.providers.snapshot();
  subscribe = (listener: () => void) => this.providers.subscribe(listener);
  resolve = (target: string) => {
    for (const provider of this.providers.snapshot()) {
      try {
        const reference = provider.identify(target);
        if (reference) return Object.freeze({ provider, reference });
      } catch {
        // Authored content is not trusted to keep a provider matcher healthy.
      }
    }
  };
  load = async (target: string, signal: AbortSignal) => {
    const resolved = this.resolve(target);
    return resolved?.provider.load(resolved.reference, signal);
  };
  register(provider: ObjectProvider) {
    if (
      !provider ||
      typeof provider.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(provider.id) ||
      typeof provider.title !== "string" ||
      !provider.title.trim() ||
      typeof provider.identify !== "function" ||
      typeof provider.load !== "function"
    )
      throw new Error(
        "An object provider needs an id, title, identifier, and loader",
      );
    this.providers.register(this.ctx, provider);
  }
}

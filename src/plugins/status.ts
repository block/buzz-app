// Contribution services observe readiness without access to plugin management.
declare module "@deepseek-ai/cordis" {
  interface Context {
    pluginStatus: {
      isActive(id: string, revision: string): boolean;
      subscribe(listener: () => void): () => void;
    };
  }
}
export {};

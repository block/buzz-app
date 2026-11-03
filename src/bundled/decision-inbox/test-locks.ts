export function installTestLocks() {
  const queues = new Map<string, Promise<void>>();
  const locks = {
    async request<T>(
      name: string,
      _options: LockOptions,
      callback: () => T | Promise<T>,
    ): Promise<T> {
      const previous = queues.get(name) ?? Promise.resolve();
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      queues.set(
        name,
        previous.then(() => held),
      );
      await previous;
      try {
        return await callback();
      } finally {
        release();
      }
    },
  };
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: locks,
  });
  return locks;
}

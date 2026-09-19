import { describe, expect, it } from "vitest";
import { createTokenStore } from "./tokenStore";

describe("createTokenStore", () => {
  it("starts with no token", () => {
    expect(createTokenStore().getToken()).toBeNull();
  });

  it("notifies subscribers when the token changes", () => {
    const store = createTokenStore();
    let seen: string | null = null;
    store.subscribe(() => {
      seen = store.getToken();
    });
    store.setToken("secret");
    expect(seen).toBe("secret");
  });

  it("clears the token and listeners on dispose", () => {
    const store = createTokenStore();
    store.setToken("secret");
    store.dispose();
    expect(store.getToken()).toBeNull();
  });
});

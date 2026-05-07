import { afterEach, describe, expect, it } from "vitest";
import {
  type ContextStorage,
  configureContextStorage,
  getContextStorage,
  resetContextStorage,
} from "../src/context-storage.js";
import type { ResolvedScope } from "../src/scope.js";

afterEach(() => {
  resetContextStorage();
});

describe("default AsyncLocalStorage-backed storage", () => {
  it("getStore returns undefined outside run()", () => {
    const storage = getContextStorage();
    expect(storage.getStore()).toBeUndefined();
  });

  it("getStore returns the active value inside run()", async () => {
    const storage = getContextStorage();
    const value: ResolvedScope = {};
    const result = await storage.run(value, () => storage.getStore());
    expect(result).toBe(value);
  });

  it("nested run() shadows the outer store", async () => {
    const storage = getContextStorage();
    const outer: ResolvedScope = {};
    const inner: ResolvedScope = {};
    const seen: Array<ResolvedScope | undefined> = [];

    await storage.run(outer, async () => {
      seen.push(storage.getStore());
      await storage.run(inner, () => {
        seen.push(storage.getStore());
      });
      seen.push(storage.getStore());
    });

    expect(seen[0]).toBe(outer);
    expect(seen[1]).toBe(inner);
    expect(seen[2]).toBe(outer);
  });

  it("getStore returns undefined after run() completes", async () => {
    const storage = getContextStorage();
    await storage.run({}, () => undefined);
    expect(storage.getStore()).toBeUndefined();
  });

  it("preserves store across awaited continuations", async () => {
    const storage = getContextStorage();
    const value: ResolvedScope = {};
    const result = await storage.run(value, async () => {
      await new Promise((r) => setTimeout(r, 0));
      return storage.getStore();
    });
    expect(result).toBe(value);
  });

  it("restores store on throw", async () => {
    const storage = getContextStorage();
    const value: ResolvedScope = {};
    await expect(
      storage.run(value, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(storage.getStore()).toBeUndefined();
  });
});

describe("configureContextStorage", () => {
  it("replaces the default storage", () => {
    const events: string[] = [];
    let store: ResolvedScope | undefined;

    const custom: ContextStorage<ResolvedScope> = {
      run<R>(value: ResolvedScope, fn: () => R | Promise<R>): R | Promise<R> {
        events.push("run");
        const prev = store;
        store = value;
        try {
          return fn();
        } finally {
          store = prev;
        }
      },
      getStore() {
        events.push("get");
        return store;
      },
    };

    configureContextStorage(custom);
    expect(getContextStorage()).toBe(custom);

    const value: ResolvedScope = {};
    getContextStorage().run(value, () => {
      const seen = getContextStorage().getStore();
      expect(seen).toBe(value);
    });
    expect(events).toContain("run");
    expect(events).toContain("get");
  });
});

describe("resetContextStorage", () => {
  it("restores the default storage", () => {
    const custom: ContextStorage<ResolvedScope> = {
      run: <R>(_v: ResolvedScope, fn: () => R | Promise<R>) => fn(),
      getStore: () => undefined,
    };
    configureContextStorage(custom);
    expect(getContextStorage()).toBe(custom);

    resetContextStorage();
    expect(getContextStorage()).not.toBe(custom);
  });
});

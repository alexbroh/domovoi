import { describe, expect, it, vi } from "vitest";
import {
  CACHE_SCHEMA_VERSION,
  InFlight,
  computeCacheKey,
  deserializeCachedValue,
  memoryCache,
  serializeCachedValue,
} from "../src/cache.js";

describe("computeCacheKey", () => {
  it("is deterministic for same inputs", () => {
    const k1 = computeCacheKey({
      providerId: "openai/gpt-4o-mini",
      modelId: "gpt-4o-mini",
      tokenizerId: "openai/cl100k_base",
      templateHash: "domovoi/v0-default",
      decisionSpace: ["a", "b", "c"],
      temperature: 0,
      providerConfigHash: "",
      formattedInput: "hello",
    });
    const k2 = computeCacheKey({
      providerId: "openai/gpt-4o-mini",
      modelId: "gpt-4o-mini",
      tokenizerId: "openai/cl100k_base",
      templateHash: "domovoi/v0-default",
      decisionSpace: ["a", "b", "c"],
      temperature: 0,
      providerConfigHash: "",
      formattedInput: "hello",
    });
    expect(k1).toBe(k2);
  });

  it("changes when decisionSpace order changes (K3: user-given order)", () => {
    const base = {
      providerId: "p",
      modelId: "m",
      tokenizerId: "t",
      templateHash: "th",
      temperature: 0,
      providerConfigHash: "",
      formattedInput: "x",
    };
    const k1 = computeCacheKey({ ...base, decisionSpace: ["a", "b", "c"] });
    const k2 = computeCacheKey({ ...base, decisionSpace: ["c", "b", "a"] });
    expect(k1).not.toBe(k2);
  });

  it("changes when providerConfigHash changes (G1)", () => {
    const base = {
      providerId: "p",
      modelId: "m",
      tokenizerId: "t",
      templateHash: "th",
      decisionSpace: ["a", "b"] as const,
      temperature: 0,
      formattedInput: "x",
    };
    const k1 = computeCacheKey({ ...base, providerConfigHash: "" });
    const k2 = computeCacheKey({ ...base, providerConfigHash: "n=10" });
    expect(k1).not.toBe(k2);
  });

  it("normalizes input via NFC + trim", () => {
    const base = {
      providerId: "p",
      modelId: "m",
      tokenizerId: "t",
      templateHash: "th",
      decisionSpace: ["a", "b"] as const,
      temperature: 0,
      providerConfigHash: "",
    };
    const k1 = computeCacheKey({ ...base, formattedInput: "  hello  " });
    const k2 = computeCacheKey({ ...base, formattedInput: "hello" });
    expect(k1).toBe(k2);
  });
});

describe("serialize/deserialize cached value", () => {
  it("round-trips Distribution preserving schemaVersion", () => {
    const d = { probs: { a: 0.7, b: 0.3 }, coverage: 0.95 };
    const raw = serializeCachedValue(d);
    expect(typeof raw).toBe("string");
    const parsed = JSON.parse(raw);
    expect(parsed.schemaVersion).toBe(CACHE_SCHEMA_VERSION);
    const back = deserializeCachedValue<"a" | "b">(raw);
    expect(back).toEqual(d);
  });

  it("returns undefined on schema-version mismatch", () => {
    const stale = JSON.stringify({
      schemaVersion: CACHE_SCHEMA_VERSION + 999,
      distribution: { probs: { a: 1 }, coverage: 1 },
      storedAt: Date.now(),
    });
    expect(deserializeCachedValue(stale)).toBeUndefined();
  });

  it("returns undefined on malformed JSON", () => {
    expect(deserializeCachedValue("not-json")).toBeUndefined();
  });
});

describe("memoryCache", () => {
  it("get returns undefined on miss", async () => {
    const c = memoryCache();
    expect(await c.get("nope")).toBeUndefined();
  });

  it("get returns the stored value", async () => {
    const c = memoryCache();
    await c.set("k", "v");
    expect(await c.get("k")).toBe("v");
  });

  it("delete removes the entry", async () => {
    const c = memoryCache();
    await c.set("k", "v");
    await c.delete("k");
    expect(await c.get("k")).toBeUndefined();
  });

  it("evicts LRU when over maxEntries", async () => {
    const c = memoryCache({ maxEntries: 2 });
    await c.set("a", "1");
    await c.set("b", "2");
    await c.set("c", "3"); // should evict "a" (oldest)
    expect(await c.get("a")).toBeUndefined();
    expect(await c.get("b")).toBe("2");
    expect(await c.get("c")).toBe("3");
  });

  it("get updates LRU recency (touched entries survive eviction)", async () => {
    const c = memoryCache({ maxEntries: 2 });
    await c.set("a", "1");
    await c.set("b", "2");
    await c.get("a"); // touch a → b is now LRU
    await c.set("c", "3"); // evicts b
    expect(await c.get("a")).toBe("1");
    expect(await c.get("b")).toBeUndefined();
    expect(await c.get("c")).toBe("3");
  });

  it("respects per-set TTL", async () => {
    const c = memoryCache();
    await c.set("k", "v", 1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 10));
    expect(await c.get("k")).toBeUndefined();
  });

  it("stats reports hits, misses, evictions", async () => {
    const c = memoryCache({ maxEntries: 1 });
    expect(c.stats()).toEqual({ size: 0, hits: 0, misses: 0, evictions: 0 });
    await c.get("nope"); // miss
    await c.set("a", "1");
    await c.get("a"); // hit
    await c.set("b", "2"); // evicts a
    const s = c.stats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
    expect(s.evictions).toBe(1);
    expect(s.size).toBe(1);
  });
});

describe("InFlight", () => {
  it("dedupes concurrent calls with the same key", async () => {
    const inflight = new InFlight<number>();
    const factory = vi.fn(() => new Promise<number>((r) => setTimeout(() => r(42), 5)));
    const [a, b, c] = await Promise.all([
      inflight.run("k", factory),
      inflight.run("k", factory),
      inflight.run("k", factory),
    ]);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(c).toBe(42);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("different keys are independent", async () => {
    const inflight = new InFlight<number>();
    const factoryA = vi.fn(async () => 1);
    const factoryB = vi.fn(async () => 2);
    const [a, b] = await Promise.all([inflight.run("a", factoryA), inflight.run("b", factoryB)]);
    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(factoryA).toHaveBeenCalledOnce();
    expect(factoryB).toHaveBeenCalledOnce();
  });

  it("clears slot after settle so subsequent calls re-fetch", async () => {
    const inflight = new InFlight<number>();
    let n = 0;
    const factory = () => Promise.resolve(++n);
    const a = await inflight.run("k", factory);
    const b = await inflight.run("k", factory);
    expect(a).toBe(1);
    expect(b).toBe(2);
  });
});

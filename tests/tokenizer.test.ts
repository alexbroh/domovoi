import { describe, expect, it } from "vitest";
import { buildLogitBias, cl100kTokenizer, findFirstTokenCollision } from "../src/tokenizer.js";

describe("cl100kTokenizer", () => {
  const tok = cl100kTokenizer();

  it("returns the singleton on repeat calls", () => {
    expect(cl100kTokenizer()).toBe(tok);
  });

  it("encodes labels with leading-space convention", () => {
    const a = tok.encode("yes");
    const b = tok.encode(" yes");
    // Both should produce the same id (same leading-space-prefixed token).
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("firstTokenId returns a number for every label", () => {
    expect(typeof tok.firstTokenId("yes")).toBe("number");
    expect(typeof tok.firstTokenId("news")).toBe("number");
    expect(typeof tok.firstTokenId("sports")).toBe("number");
  });

  it("returns different ids for distinct labels", () => {
    expect(tok.firstTokenId("yes")).not.toBe(tok.firstTokenId("no"));
    expect(tok.firstTokenId("news")).not.toBe(tok.firstTokenId("sports"));
  });
});

describe("findFirstTokenCollision", () => {
  const tok = cl100kTokenizer();

  it("returns undefined for collision-free space", () => {
    expect(findFirstTokenCollision(tok, ["yes", "no"])).toBeUndefined();
    expect(findFirstTokenCollision(tok, ["news", "sports", "music"])).toBeUndefined();
  });

  it("detects collision when two labels share first-token id", () => {
    // Force a collision by using identical labels (defensive — the validator
    // should also reject duplicates upstream, but the tokenizer-level check
    // should still see the collision).
    const result = findFirstTokenCollision(tok, ["yes", "yes2"]);
    // 'yes' and 'yes2' both have ' yes' as the first token in cl100k_base.
    expect(result).toEqual({ a: "yes", b: "yes2", tokenId: tok.firstTokenId("yes") });
  });
});

describe("buildLogitBias", () => {
  const tok = cl100kTokenizer();

  it("maps every in-space first-token id to +100 by default", () => {
    const bias = buildLogitBias(tok, ["yes", "no"]);
    const yesId = String(tok.firstTokenId("yes"));
    const noId = String(tok.firstTokenId("no"));
    expect(bias[yesId]).toBe(100);
    expect(bias[noId]).toBe(100);
    expect(Object.keys(bias)).toHaveLength(2);
  });

  it("respects custom bias value", () => {
    const bias = buildLogitBias(tok, ["a"], 50);
    expect(Object.values(bias).every((v) => v === 50)).toBe(true);
  });
});

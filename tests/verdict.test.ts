import { describe, expect, it, vi } from "vitest";
import {
  type Verdict,
  type VerdictMeta,
  filter,
  isClassified,
  isUncertain,
  isUnknown,
  match,
} from "../src/index.js";

const META: VerdictMeta = {
  providerUsed: "mock/test",
  providersAttempted: ["mock/test"],
  providerErrors: [],
  latencyMs: 0,
  cacheHit: false,
  coverageQuality: "exact",
  distributionSource: "logprobs",
};

describe("verdict type guards", () => {
  it("isClassified narrows to Classified", () => {
    const v: Verdict<"a" | "b"> = {
      kind: "classified",
      value: "a",
      probability: 0.9,
      meta: META,
    };
    if (isClassified(v)) {
      expect(v.value).toBe("a");
      expect(v.probability).toBe(0.9);
    } else {
      expect.fail("isClassified false-negative");
    }
  });

  it("isUncertain narrows to Uncertain", () => {
    const v: Verdict<"a" | "b"> = {
      kind: "uncertain",
      top: "a",
      probability: 0.55,
      runnerUp: "b",
      distribution: { probs: { a: 0.55, b: 0.45 }, coverage: 1 },
      meta: META,
    };
    if (isUncertain(v)) {
      expect(v.top).toBe("a");
      expect(v.runnerUp).toBe("b");
    } else {
      expect.fail("isUncertain false-negative");
    }
  });

  it("isUnknown narrows to Unknown", () => {
    const v: Verdict<"a" | "b"> = {
      kind: "unknown",
      reason: {
        type: "out_of_distribution",
        coverage: 0.1,
        topIfRenormalized: "a",
        probabilityIfRenormalized: 0.7,
      },
      meta: META,
    };
    if (isUnknown(v)) {
      expect(v.reason.type).toBe("out_of_distribution");
    } else {
      expect.fail("isUnknown false-negative");
    }
  });

  it("type guards are mutually exclusive", () => {
    const cases: Verdict<"a">[] = [
      { kind: "classified", value: "a", probability: 1, meta: META },
      {
        kind: "uncertain",
        top: "a",
        probability: 0.5,
        runnerUp: "a",
        distribution: { probs: { a: 1 }, coverage: 1 },
        meta: META,
      },
      {
        kind: "unknown",
        reason: {
          type: "chain_exhausted",
          lastDistribution: { probs: { a: 0.5 }, coverage: 1 },
          providersAttempted: 1,
        },
        meta: META,
      },
    ];
    for (const v of cases) {
      const flags = [isClassified(v), isUncertain(v), isUnknown(v)];
      expect(flags.filter(Boolean).length).toBe(1);
    }
  });
});

describe("match", () => {
  it("dispatches to the right handler", () => {
    const c: Verdict<"x"> = { kind: "classified", value: "x", probability: 1, meta: META };
    const result = match(c, {
      classified: (v) => `c:${v.value}`,
      uncertain: () => "u",
      unknown: () => "k",
    });
    expect(result).toBe("c:x");
  });

  it("invokes only one handler per call", () => {
    const cls = vi.fn(() => "cls");
    const unc = vi.fn(() => "unc");
    const unk = vi.fn(() => "unk");
    match(
      {
        kind: "uncertain",
        top: "a",
        probability: 0.5,
        runnerUp: "b",
        distribution: { probs: { a: 0.5, b: 0.5 }, coverage: 1 },
        meta: META,
      } as Verdict<"a" | "b">,
      { classified: cls, uncertain: unc, unknown: unk },
    );
    expect(cls).not.toHaveBeenCalled();
    expect(unc).toHaveBeenCalledOnce();
    expect(unk).not.toHaveBeenCalled();
  });
});

describe("filter (Verdict.filter)", () => {
  it("passes Classified through if pred returns true", () => {
    const v: Verdict<"a" | "b"> = { kind: "classified", value: "a", probability: 1, meta: META };
    const out = filter<"a" | "b">(() => true)(v);
    expect(out).toBe(v);
  });

  it("converts Classified to Unknown predicate_rejected if pred returns false", () => {
    const v: Verdict<"a" | "b"> = { kind: "classified", value: "a", probability: 1, meta: META };
    const out = filter<"a" | "b">(() => false)(v);
    expect(out.kind).toBe("unknown");
    if (out.kind === "unknown" && out.reason.type === "predicate_rejected") {
      expect(out.reason.previousKind).toBe("classified");
    } else {
      expect.fail("expected Unknown { predicate_rejected, previousKind: 'classified' }");
    }
  });

  it("converts Uncertain to Unknown predicate_rejected with previousKind 'uncertain'", () => {
    const v: Verdict<"a" | "b"> = {
      kind: "uncertain",
      top: "a",
      probability: 0.5,
      runnerUp: "b",
      distribution: { probs: { a: 0.5, b: 0.5 }, coverage: 1 },
      meta: META,
    };
    const out = filter<"a" | "b">(() => false)(v);
    if (out.kind === "unknown" && out.reason.type === "predicate_rejected") {
      expect(out.reason.previousKind).toBe("uncertain");
    } else {
      expect.fail("expected predicate_rejected previousKind 'uncertain'");
    }
  });

  it("passes Unknown through unchanged (no pred call)", () => {
    const pred = vi.fn(() => false);
    const v: Verdict<"a" | "b"> = {
      kind: "unknown",
      reason: {
        type: "chain_exhausted",
        lastDistribution: { probs: { a: 1, b: 0 }, coverage: 1 },
        providersAttempted: 1,
      },
      meta: META,
    };
    const out = filter<"a" | "b">(pred)(v);
    expect(pred).not.toHaveBeenCalled();
    expect(out).toBe(v);
  });

  it("predicate sees both Classified.value and Uncertain.top via pick", () => {
    const deprecated = new Set(["dep"]);
    const pred = (v: { kind: "classified" | "uncertain"; value?: string; top?: string }) => {
      const pick = v.kind === "classified" ? v.value : v.top;
      return !deprecated.has(pick as string);
    };
    const cv: Verdict<"dep" | "ok"> = {
      kind: "classified",
      value: "dep",
      probability: 1,
      meta: META,
    };
    const uv: Verdict<"dep" | "ok"> = {
      kind: "uncertain",
      top: "dep",
      probability: 0.55,
      runnerUp: "ok",
      distribution: { probs: { dep: 0.55, ok: 0.45 }, coverage: 1 },
      meta: META,
    };
    expect(filter<"dep" | "ok">(pred as never)(cv).kind).toBe("unknown");
    expect(filter<"dep" | "ok">(pred as never)(uv).kind).toBe("unknown");
  });
});

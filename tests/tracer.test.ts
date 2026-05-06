import { describe, expect, it } from "vitest";
import { noopTracer, type Span, type Tracer } from "../src/tracer.js";

describe("noopTracer", () => {
  it("startSpan returns a span object with all four methods", () => {
    const span = noopTracer.startSpan("test");
    expect(typeof span.setAttribute).toBe("function");
    expect(typeof span.recordException).toBe("function");
    expect(typeof span.setStatus).toBe("function");
    expect(typeof span.end).toBe("function");
  });

  it("all methods are no-ops (don't throw)", () => {
    const span = noopTracer.startSpan("test", { "gen_ai.system": "openai" });
    expect(() => {
      span.setAttribute("k", "v");
      span.setAttribute("n", 42);
      span.setAttribute("b", true);
      span.setAttribute("arr", ["a", "b"]);
      span.recordException(new Error("test"));
      span.setStatus("ok");
      span.setStatus("error", "boom");
      span.end();
    }).not.toThrow();
  });

  it("returns a span even with no attributes argument", () => {
    expect(() => noopTracer.startSpan("test")).not.toThrow();
  });
});

describe("Tracer interface contract", () => {
  it("a custom tracer satisfies the type", () => {
    const events: string[] = [];
    const tracer: Tracer = {
      startSpan: (name) => {
        events.push(`start:${name}`);
        const span: Span = {
          setAttribute: (k, v) => {
            events.push(`attr:${k}=${JSON.stringify(v)}`);
          },
          recordException: (err) => {
            events.push(`ex:${(err as Error).message}`);
          },
          setStatus: (status) => {
            events.push(`status:${status}`);
          },
          end: () => {
            events.push(`end:${name}`);
          },
        };
        return span;
      },
    };

    const span = tracer.startSpan("classify", { "domovoi.label_space": ["a", "b"] });
    span.setAttribute("gen_ai.usage.input_tokens", 100);
    span.setStatus("ok");
    span.end();

    expect(events).toEqual([
      "start:classify",
      "attr:gen_ai.usage.input_tokens=100",
      "status:ok",
      "end:classify",
    ]);
  });
});

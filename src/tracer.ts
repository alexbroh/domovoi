/**
 * Minimal, OpenTelemetry-compatible Tracer/Span interfaces.
 *
 * domovoi emits one span per provider call when a Tracer is present in
 * scope. Attributes follow the OTel GenAI semantic conventions (v1.40+
 * shape, `Development` status as of May 2026) for `gen_ai.*` fields,
 * with domovoi-specific concepts under `domovoi.*`.
 *
 * Users adapt their existing OpenTelemetry tracer with a ~10-line wrapper:
 *
 *   import { trace } from "@opentelemetry/api";
 *   const otelTracer = trace.getTracer("my-app");
 *   const domovoiTracer: Tracer = {
 *     startSpan: (name, attrs) =>
 *       otelTracer.startSpan(name, { attributes: attrs }),
 *   };
 *
 * The interfaces are deliberately minimal — no SpanContext, no propagation
 * primitives, no events. domovoi-the-library does not depend on
 * `@opentelemetry/api`; consumers wire it in.
 */

export type AttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

export interface Span {
  setAttribute(key: string, value: AttributeValue): void;
  recordException(err: unknown): void;
  setStatus(status: "ok" | "error", message?: string): void;
  end(): void;
}

export interface Tracer {
  startSpan(name: string, attrs?: Record<string, AttributeValue>): Span;
}

const noopSpan: Span = {
  setAttribute: () => {},
  recordException: () => {},
  setStatus: () => {},
  end: () => {},
};

/**
 * Used by the engine when no tracer is in scope. Lets engine code call
 * tracer methods unconditionally without null-checks at every site.
 */
export const noopTracer: Tracer = {
  startSpan: () => noopSpan,
};

/**
 * A tool result that carries a typed value beside its text. A Code Mode
 * script receives the value, checked against the `structuredOutput` schema
 * of the tool. The area of the tool defines the class of its result.
 */
export abstract class StructuredToolResult {
  abstract get structuredContent(): unknown;
}

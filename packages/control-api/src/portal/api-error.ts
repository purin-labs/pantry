import { controlApiProblemMessage, parseControlApiProblem } from "./errors.ts";

export function readApiError(raw: unknown): string {
  return controlApiProblemMessage(parseControlApiProblem(raw));
}

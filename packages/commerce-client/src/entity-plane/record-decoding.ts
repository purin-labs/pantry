import {
  ContractRefusalError,
  type ContractDecodeResult,
} from "@purin-labs/commerce-contracts/schema";

/** The value of a record schema parser; a refusal throws its contract error. */
export function decodeRecord<T>(
  parser: (input: unknown) => ContractDecodeResult<T>,
  input: unknown,
): T {
  const parsed = parser(input);
  if (parsed.ok) return parsed.value;
  throw new ContractRefusalError(parsed.error);
}

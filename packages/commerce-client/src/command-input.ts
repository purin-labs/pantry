/**
 * What a caller passes to a client command method (Plan 80 step 1): the
 * command's own fields, the merchant and the idempotency key. The client
 * puts the merchant and the other resource ids in the path and the key in
 * the `Idempotency-Key` header. The server adds the command version, the
 * merchant's external reference and the time of the request, so a caller
 * cannot pass them.
 */
export type CommerceCommandInput<Command> = Command extends unknown
  ? Omit<Command, CommerceServerCommandField> & {
      readonly [Field in CommerceServerCommandField]?: never;
    }
  : never;

/** The command fields that the server gives, never the caller. */
type CommerceServerCommandField =
  "schemaVersion" | "organisationId" | "actionNonce" | "requestedAt";

const SERVER_COMMAND_FIELDS: readonly CommerceServerCommandField[] = [
  "schemaVersion",
  "organisationId",
  "actionNonce",
  "requestedAt",
];

/**
 * The client input of a whole command, for a caller that checks the command
 * with its contract parser before it sends it.
 */
export function commerceCommandInput<Command extends object>(
  command: Command,
): CommerceCommandInput<Command> {
  const input: Record<string, unknown> = { ...(command as object) };
  for (const field of SERVER_COMMAND_FIELDS) delete input[field];
  return input as CommerceCommandInput<Command>;
}

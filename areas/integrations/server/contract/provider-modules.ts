import { definePort } from "@purin-labs/kernel/port";
import type { Env } from "@purin-labs/kernel/env";
import type { JsonObject } from "@purin-labs/kernel/http";
import type { IngressQueueMessageError } from "@purin-labs/kernel/queue-fields";
import type { Result } from "@purin-labs/kernel/result";
import type { OrganisationModuleHost } from "@purin-labs/tenancy/actors/organisation/module-host";
import type {
  BegunCredentialRotation,
  CredentialRotationFailureCode,
} from "@purin-labs/area-integrations-contract/server/credential-lifecycle";
import type { ProviderAdapterByProvider } from "@purin-labs/area-integrations-contract/server/provider-adapter";

/**
 * A provider whose code is a module of its own, so that a removal deletes
 * the module and its registration (Refactor 17, step A2.5). The module gives
 * its entry of the provider catalogue, the check of a replacement
 * credential and its messages of the event queue.
 */
export type ProviderModule<P extends keyof ProviderAdapterByProvider> =
  Readonly<{
    adapter: ProviderAdapterByProvider[P];
    validateReplacementCredential(
      rotation: BegunCredentialRotation,
      replacementSecret: string,
    ): Promise<
      | { readonly ok: true }
      | {
          readonly ok: false;
          readonly failureCode: CredentialRotationFailureCode;
        }
    >;
    queueMessages: ProviderQueueMessages;
  }>;

/** The provider modules, which the Worker registers (`worker-ports.ts`). */
export type ProviderModules = Readonly<{
  shopify: ProviderModule<"shopify">;
}>;

export const providerModules = definePort<ProviderModules>("provider_modules");

/**
 * A message of the event queue that a provider module owns. Its type starts
 * with the name of the module, for example `shopify.commerce_refresh.v1`.
 */
export type ProviderQueueMessage = Readonly<{
  type: `${keyof ProviderModules}.${string}`;
}>;

/** What the event queue does with a message after its handler. */
export type ProviderQueueOutcome = "ack" | "retry";

/** A provider message that its module has read, with its handler. */
export type ProviderQueueWork = Readonly<{
  type: ProviderQueueMessage["type"];
  /** Handles the message. It does not ack or retry the message. */
  run(env: Env, messageId: string): Promise<ProviderQueueOutcome>;
}>;

/** The messages of the event queue that one provider module owns. */
export type ProviderQueueMessages = Readonly<{
  /**
   * Reads one message of the event queue. It returns null when the type is
   * not a type of this module.
   */
  parse(
    type: string,
    body: JsonObject,
  ): Result<ProviderQueueWork, IngressQueueMessageError> | null;
}>;

/**
 * A part of the Organisation actor that a provider module owns: its tables
 * in the Actor SQLite and its commands. The Actor class has one RPC method
 * for each command, and it gives the part its module host.
 */
export type ProviderOrganisationPart<Rpc extends object> = Readonly<{
  /** Creates the tables of the part. It writes no row. */
  createSchema(sql: SqlStorage): void;
  /** The commands of the part for one Organisation actor. */
  open(host: OrganisationModuleHost): Rpc;
}>;

/**
 * The routes of the Worker gateway that a provider module serves, by route
 * kind. The gateway routing of the webhook surface gives the route kinds.
 */
export type ProviderGatewayRoutes<
  AdminRoute extends string,
  WebhookRoute extends string,
> = Readonly<{
  admin: Readonly<
    Record<AdminRoute, (request: Request, env: Env) => Promise<Response>>
  >;
  webhooks: Readonly<
    Record<
      WebhookRoute,
      (
        request: Request,
        env: Env,
        organisationIdRaw: string,
      ) => Promise<Response>
    >
  >;
}>;

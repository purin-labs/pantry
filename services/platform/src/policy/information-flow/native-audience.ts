import type { RequestAuthority } from "@purin-labs/contracts";
import type { Variant } from "@purin-labs/type-utils";
import { canonicalJson } from "@purin-labs/std";
import type { OrganisationId } from "../../ids";
import type { FlowAudience } from "./types";

type NativeAudienceRevisions = readonly Readonly<{
  identity: string;
  revision: number;
}>[];

class NativeChatAudience {
  readonly #validated = true;
  private constructor(
    readonly organisationId: OrganisationId,
    readonly authority: Variant<RequestAuthority, "control">,
    readonly readers: readonly FlowAudience[],
    readonly revisions: NativeAudienceRevisions,
  ) {
    Object.freeze(authority);
    for (const reader of readers) Object.freeze(reader);
    for (const revision of revisions) Object.freeze(revision);
    Object.freeze(readers);
    Object.freeze(revisions);
    Object.freeze(this);
  }
  static create(
    organisationId: OrganisationId,
    authority: Variant<RequestAuthority, "control">,
    readers: readonly FlowAudience[],
    revisions: NativeAudienceRevisions,
  ): NativeChatAudience {
    return new NativeChatAudience(
      organisationId,
      authority,
      readers,
      revisions,
    );
  }
  static matchesAuthority(
    value: unknown,
    authority: RequestAuthority,
  ): value is NativeChatAudience {
    return (
      typeof value === "object" &&
      value !== null &&
      #validated in value &&
      canonicalJson(value.authority) === canonicalJson(authority)
    );
  }
}

export type { NativeChatAudience };

// Only the live membership resolver may mint this kernel input.
export function createNativeChatAudience(
  organisationId: OrganisationId,
  authority: Variant<RequestAuthority, "control">,
  readers: readonly FlowAudience[],
  revisions: NativeAudienceRevisions,
): NativeChatAudience {
  return NativeChatAudience.create(
    organisationId,
    authority,
    readers,
    revisions,
  );
}
export function nativeChatAudienceMatchesAuthority(
  value: unknown,
  authority: RequestAuthority,
): value is NativeChatAudience {
  return NativeChatAudience.matchesAuthority(value, authority);
}

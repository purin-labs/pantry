import type {
  CheckoutProfile,
  CheckoutProfileConfiguration,
} from "@purin-labs/commerce-contracts";
import { decodeRecord } from "./entity-plane/record-decoding.ts";
import {
  parseActivateCommerceCheckoutProfileV1 as parseActivateCommerceCheckoutProfileV1Record,
  parseCreateCommerceCheckoutProfileDraftV1 as parseCreateCommerceCheckoutProfileDraftV1Record,
  parsePublishCommerceCheckoutProfileV1 as parsePublishCommerceCheckoutProfileV1Record,
  parseReplaceCommerceCheckoutProfileDraftV1 as parseReplaceCommerceCheckoutProfileDraftV1Record,
  parseRetireCommerceCheckoutProfileV1 as parseRetireCommerceCheckoutProfileV1Record,
  parseCommerceActiveCheckoutProfileV1 as parseCommerceActiveCheckoutProfileV1Record,
  parseCommerceCheckoutProfileActivationsV1,
  parseCommerceCheckoutProfilesV1,
  parseCommerceCheckoutProfileStorefrontIdsV1,
  parseWireCheckoutProfile as parseCheckoutProfileRecord,
} from "@purin-labs/commerce-contracts/records/api-checkout-profile";

export type CommerceCheckoutProfileActivationV1 = Readonly<{
  merchantId: string;
  storefrontId: string;
  checkoutProfileId: string;
  checkoutProfileRevision: number;
  activatedAt: string;
  activatedBy: string;
}>;

export type CommerceActiveCheckoutProfileV1 = Readonly<{
  activation: CommerceCheckoutProfileActivationV1;
  profile: CheckoutProfile;
}>;

export type CreateCommerceCheckoutProfileDraftV1 = Readonly<{
  schemaVersion: "underclerk.create-checkout-profile-draft.v1";
  merchantId: string;
  checkoutProfileId: string;
  name: string;
  configuration: CheckoutProfileConfiguration;
  createdAt: string;
}>;

export type ReplaceCommerceCheckoutProfileDraftV1 = Readonly<{
  schemaVersion: "underclerk.replace-checkout-profile-draft.v1";
  merchantId: string;
  checkoutProfileId: string;
  expectedRevision: number;
  name: string;
  configuration: CheckoutProfileConfiguration;
  updatedAt: string;
}>;

export type PublishCommerceCheckoutProfileV1 = Readonly<{
  schemaVersion: "underclerk.publish-checkout-profile.v1";
  merchantId: string;
  checkoutProfileId: string;
  expectedRevision: number;
  publishedAt: string;
  publishedBy: string;
}>;

export type RetireCommerceCheckoutProfileV1 = Readonly<{
  schemaVersion: "underclerk.retire-checkout-profile.v1";
  merchantId: string;
  checkoutProfileId: string;
  expectedRevision: number;
  retiredAt: string;
  retiredBy: string;
}>;

export type ActivateCommerceCheckoutProfileV1 = Readonly<{
  schemaVersion: "underclerk.activate-checkout-profile.v1";
  merchantId: string;
  storefrontId: string;
  checkoutProfileId: string;
  checkoutProfileRevision: number;
  activatedAt: string;
  activatedBy: string;
}>;

export function parseCreateCheckoutProfileDraftCommand(
  raw: unknown,
): CreateCommerceCheckoutProfileDraftV1 {
  return decodeRecord(parseCreateCommerceCheckoutProfileDraftV1Record, raw);
}

export function parseReplaceCheckoutProfileDraftCommand(
  raw: unknown,
): ReplaceCommerceCheckoutProfileDraftV1 {
  return decodeRecord(parseReplaceCommerceCheckoutProfileDraftV1Record, raw);
}

export function parsePublishCheckoutProfileCommand(
  raw: unknown,
): PublishCommerceCheckoutProfileV1 {
  return decodeRecord(parsePublishCommerceCheckoutProfileV1Record, raw);
}

export function parseRetireCheckoutProfileCommand(
  raw: unknown,
): RetireCommerceCheckoutProfileV1 {
  return decodeRecord(parseRetireCommerceCheckoutProfileV1Record, raw);
}

export function parseActivateCheckoutProfileCommand(
  raw: unknown,
): ActivateCommerceCheckoutProfileV1 {
  return decodeRecord(parseActivateCommerceCheckoutProfileV1Record, raw);
}

export function parseCheckoutProfile(raw: unknown): CheckoutProfile {
  return decodeRecord(parseCheckoutProfileRecord, raw);
}

export function parseCheckoutProfiles(
  raw: unknown,
): readonly CheckoutProfile[] {
  return decodeRecord(parseCommerceCheckoutProfilesV1, raw);
}

export function parseCheckoutProfileActivations(
  raw: unknown,
): readonly CommerceCheckoutProfileActivationV1[] {
  return decodeRecord(parseCommerceCheckoutProfileActivationsV1, raw);
}

export function parseStorefrontIds(raw: unknown): readonly string[] {
  return decodeRecord(parseCommerceCheckoutProfileStorefrontIdsV1, raw);
}

export function parseActiveCheckoutProfile(
  raw: unknown,
): CommerceActiveCheckoutProfileV1 {
  return decodeRecord(parseCommerceActiveCheckoutProfileV1Record, raw);
}

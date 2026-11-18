import { CommerceAuthority } from "../commerce-authority.ts";
import type { NotificationGateway } from "../notification-gateway.ts";
import type { WebhookSender } from "../webhooks.ts";
import type { ArchiveStore } from "../archive.ts";
import type { MediaStore } from "../plugins/media/index.ts";
import { BuyerSessionAuthority } from "../buyer-session.ts";
import type { BuyerAccountGateway } from "../buyer-account.ts";
import { ShippingAddressValidationService } from "../shipping-address-validation.ts";
import { EntityPlaneService } from "../entity-plane/service.ts";
import type { ApiAccess } from "../api-access.ts";
import type { BankPayouts } from "../payments/bank-payouts.ts";
import type { SquarePaymentAccounts } from "../payments/square/square-payments.ts";
import type { StripePaymentAccounts } from "../payments/stripe/stripe-payments.ts";
import type { FeedConsumers } from "../feed-consumers.ts";
import type { ShopNameRegistry } from "../shop-names.ts";

/** What the route functions of the HTTP API read (Refactor 14). */
export type HttpRouteContext = Readonly<{
  authority: CommerceAuthority;
  buyerSessions: BuyerSessionAuthority;
  addressValidations: ShippingAddressValidationService | undefined;
  serviceToken: string;
  access: ApiAccess | undefined;
  paymentAccounts: StripePaymentAccounts | undefined;
  squareAccounts: SquarePaymentAccounts | undefined;
  bankPayouts: BankPayouts | undefined;
  feedConsumers: FeedConsumers | undefined;
  buyerAccounts: BuyerAccountGateway;
  entityPlane: EntityPlaneService | undefined;
  notifications: NotificationGateway | undefined;
  webhooks: WebhookSender | undefined;
  archive: ArchiveStore | undefined;
  media: MediaStore | undefined;
  shopNames: ShopNameRegistry | undefined;
}>;

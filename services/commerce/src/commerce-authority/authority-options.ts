import type { CommerceDatabase } from "../database.ts";
import type { CommerceSigner } from "./contracts.ts";
import type {
  InPersonCollectionGateway,
  PaymentProvider,
} from "../payments/provider.ts";
import type { ShippingGateway } from "../shipping-gateway.ts";
import type {
  CheckoutProviderCapabilityHealthProvider,
  RegionalShipping,
} from "../regional-shipping.ts";
import type { QuickJsFunctionRuntime } from "../plugins/function-runtime.ts";

export type CommerceAuthorityOptions = Readonly<{
  database: CommerceDatabase;
  signer: CommerceSigner;
  paymentGateway: PaymentProvider;
  inPersonCollectionGateway?: InPersonCollectionGateway;
  now: () => string;
  shippingGateway: ShippingGateway;
  checkoutCapabilityHealthProvider?: CheckoutProviderCapabilityHealthProvider;
  /** The root secret for customer data; without it there are no accounts. */
  customerDataRoot?: string;
  /** Routes, carriers, tax and duty of shipped orders; none means pickup only. */
  shipping?: RegionalShipping;
  /** Runs merchant plugin functions; without it none can be installed. */
  functionRuntime?: QuickJsFunctionRuntime;
  /** The addresses that webhooks may post to; public HTTPS when absent. */
  webhookAddressAllowed?: (url: string) => boolean;
}>;

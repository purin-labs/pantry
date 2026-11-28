import React from "react";
import type {
  CommercePaymentClientConfirmationV1,
  CommercePaymentPublicSessionV1,
} from "@purin-labs/commerce-client";
import type { Variant, VariantBy } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import type {
  ProviderUiError,
  SquareCard,
  StripeClient,
  StripeElements,
  StripePaymentElement,
} from "./storefront-types.ts";
import { money } from "./storefront-basket.tsx";

type ProviderPaymentViewProps = Readonly<{
  session: CommercePaymentPublicSessionV1;
  total: Readonly<{ amountMinor: number; currency: string }>;
  onConfirmed: (confirmation: CommercePaymentClientConfirmationV1) => void;
}>;

type ProviderPaymentViewState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; message: string | null }>
  | Readonly<{ kind: "submitting" }>
  | Readonly<{ kind: "failed"; message: string }>;

export class ProviderPaymentView extends React.Component<
  ProviderPaymentViewProps,
  ProviderPaymentViewState
> {
  state: ProviderPaymentViewState = { kind: "loading" };
  #stripe: StripeClient | undefined;
  #stripeElements: StripeElements | undefined;
  #stripePaymentElement: StripePaymentElement | undefined;
  #squareCard: SquareCard | undefined;

  componentDidMount(): void {
    void this.mountProvider();
  }

  componentWillUnmount(): void {
    this.#stripePaymentElement?.unmount();
    if (this.#squareCard !== undefined) void this.#squareCard.destroy();
  }

  async mountProvider(): Promise<void> {
    const session = this.props.session;
    if (session.kind === "hosted_redirect") {
      this.setState({ kind: "ready", message: null });
      return;
    }
    switch (session.publicConfiguration.provider) {
      case "stripe_online":
        await this.mountStripe(session.publicConfiguration);
        return;
      case "square_online":
        await this.mountSquare(session.publicConfiguration);
        return;
      case "gmo_pg_online":
        this.setState({
          kind: "failed",
          message:
            "This payment collection method is not published for this storefront.",
        });
        return;
      default:
        return assertNever(
          session.publicConfiguration,
          "Unhandled storefront state",
        );
    }
  }

  async mountStripe(
    configuration: VariantBy<
      Variant<
        CommercePaymentPublicSessionV1,
        "embedded_public_session"
      >["publicConfiguration"],
      "provider",
      "stripe_online"
    >,
  ): Promise<void> {
    try {
      await loadProviderScript(
        "stripe-payment-sdk",
        "https://js.stripe.com/clover/stripe.js",
      );
      if (window.Stripe === undefined)
        throw new Error("Stripe payment collection did not load.");
      this.#stripe = window.Stripe(configuration.publishableKey, {
        stripeAccount: configuration.connectedAccountId,
      });
      this.#stripeElements = this.#stripe.elements({
        clientSecret: configuration.clientSecret,
      });
      this.#stripePaymentElement = this.#stripeElements.create("payment");
      this.#stripePaymentElement.mount("#stripe-payment-element");
      this.setState({ kind: "ready", message: null });
    } catch (error) {
      this.setState({ kind: "failed", message: paymentUiError(error) });
    }
  }

  async mountSquare(
    configuration: VariantBy<
      Variant<
        CommercePaymentPublicSessionV1,
        "embedded_public_session"
      >["publicConfiguration"],
      "provider",
      "square_online"
    >,
  ): Promise<void> {
    try {
      const source =
        configuration.environment === "production"
          ? "https://web.squarecdn.com/v1/square.js"
          : "https://sandbox.web.squarecdn.com/v1/square.js";
      await loadProviderScript("square-payment-sdk", source);
      if (window.Square === undefined)
        throw new Error("Square payment collection did not load.");
      const payments = window.Square.payments(
        configuration.applicationId,
        configuration.locationId,
      );
      this.#squareCard = await payments.card();
      await this.#squareCard.attach("#square-card-element");
      this.setState({ kind: "ready", message: null });
    } catch (error) {
      this.setState({ kind: "failed", message: paymentUiError(error) });
    }
  }

  submitPayment = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const session = this.props.session;
    if (this.state.kind !== "ready") return;
    if (session.kind === "hosted_redirect") {
      window.location.assign(session.redirectUrl);
      return;
    }
    switch (session.publicConfiguration.provider) {
      case "stripe_online":
        void this.submitStripe(session.publicConfiguration.clientSecret);
        return;
      case "square_online":
        void this.submitSquare();
        return;
      case "gmo_pg_online":
        return;
      default:
        return assertNever(
          session.publicConfiguration,
          "Unhandled storefront state",
        );
    }
  };

  async submitStripe(clientSecret: string): Promise<void> {
    if (this.#stripe === undefined || this.#stripeElements === undefined)
      return;
    this.setState({ kind: "submitting" });
    try {
      const submission = await this.#stripeElements.submit();
      if (submission.error !== undefined) {
        this.setState({
          kind: "ready",
          message: providerErrorMessage(submission.error),
        });
        return;
      }
      const confirmation = await this.#stripe.confirmPayment({
        elements: this.#stripeElements,
        clientSecret,
        confirmParams: { return_url: window.location.href },
        redirect: "if_required",
      });
      if (confirmation.error !== undefined) {
        this.setState({
          kind: "ready",
          message: providerErrorMessage(confirmation.error),
        });
        return;
      }
      this.props.onConfirmed({ kind: "provider_ui_completed" });
    } catch (error) {
      this.setState({ kind: "ready", message: paymentUiError(error) });
    }
  }

  async submitSquare(): Promise<void> {
    if (this.#squareCard === undefined) return;
    this.setState({ kind: "submitting" });
    try {
      const tokenization = await this.#squareCard.tokenize({
        amount: (this.props.total.amountMinor / 100).toFixed(2),
        currencyCode: this.props.total.currency,
        intent: "CHARGE",
      });
      if (tokenization.status === "OK" && "token" in tokenization) {
        this.props.onConfirmed({
          kind: "square_source_token",
          sourceToken: tokenization.token,
        });
        return;
      }
      const error =
        "errors" in tokenization ? tokenization.errors?.[0] : undefined;
      this.setState({ kind: "ready", message: providerErrorMessage(error) });
    } catch (error) {
      this.setState({ kind: "ready", message: paymentUiError(error) });
    }
  }

  render(): React.ReactNode {
    const session = this.props.session;
    const hosted = session.kind === "hosted_redirect";
    return (
      <section
        className="checkout-card payment-collection-card"
        aria-labelledby="payment-heading"
      >
        <p className="eyebrow">Secure checkout</p>
        <h1 id="payment-heading" tabIndex={-1}>
          Complete payment
        </h1>
        <p>
          Your payment details are handled directly by the selected payment
          provider.
        </p>
        <form className="provider-payment-form" onSubmit={this.submitPayment}>
          {hosted ? (
            <p>
              You’ll continue to the provider’s secure page and return here when
              payment is complete.
            </p>
          ) : (
            this.renderEmbeddedProvider(session)
          )}
          {paymentFormError(this.state) === null ? null : (
            <p className="form-error" role="alert">
              {paymentFormError(this.state)}
            </p>
          )}
          <button type="submit" disabled={this.state.kind !== "ready"}>
            {this.state.kind === "loading"
              ? "Loading secure payment…"
              : this.state.kind === "submitting"
                ? "Confirming payment…"
                : hosted
                  ? "Continue to secure payment"
                  : `Pay ${money(this.props.total)}`}
          </button>
        </form>
      </section>
    );
  }

  renderEmbeddedProvider(
    session: Variant<
      CommercePaymentPublicSessionV1,
      "embedded_public_session"
    >,
  ): React.ReactNode {
    switch (session.publicConfiguration.provider) {
      case "stripe_online":
        return (
          <div
            id="stripe-payment-element"
            className="provider-payment-element"
            aria-label="Payment details"
          />
        );
      case "square_online":
        return (
          <div
            id="square-card-element"
            className="provider-payment-element"
            aria-label="Card details"
          />
        );
      case "gmo_pg_online":
        return <p>This payment collection method is unavailable.</p>;
      default:
        return assertNever(
          session.publicConfiguration,
          "Unhandled storefront state",
        );
    }
  }
}

async function loadProviderScript(id: string, source: string): Promise<void> {
  const existing = document.getElementById(id);
  if (existing instanceof HTMLScriptElement) {
    if (existing.dataset.loaded === "true") return;
    await waitForProviderScript(existing);
    return;
  }
  const script = document.createElement("script");
  script.id = id;
  script.src = source;
  script.async = true;
  document.head.append(script);
  await waitForProviderScript(script);
}

function waitForProviderScript(script: HTMLScriptElement): Promise<void> {
  return new Promise((resolve, reject) => {
    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        resolve();
      },
      { once: true },
    );
    script.addEventListener(
      "error",
      () => reject(new Error("The secure payment service could not load.")),
      { once: true },
    );
  });
}

function providerErrorMessage(error: ProviderUiError | undefined): string {
  return (
    error?.message?.trim() ||
    "Payment details could not be confirmed. Check them and try again."
  );
}

function paymentFormError(state: ProviderPaymentViewState): string | null {
  return state.kind === "failed" || state.kind === "ready"
    ? state.message
    : null;
}

function paymentUiError(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "The secure payment service is temporarily unavailable.";
}

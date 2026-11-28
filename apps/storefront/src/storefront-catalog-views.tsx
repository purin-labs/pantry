import React from "react";
import type {
  CommerceBuyerCatalogListingV1,
  CommerceBuyerCatalogV1,
  CommerceBuyerShippingServiceV1,
} from "@purin-labs/commerce-client";
import type { Variant } from "@purin-labs/type-utils";
import {
  CartDrawer,
  PatisserieMenu,
  patisserieProduct,
  patisserieMastheadDetail,
  type PatisserieMenuItem,
} from "./patisserie.tsx";
import type { StorefrontApp } from "./storefront.tsx";
import type {
  CafeBasket,
  CafeConfiguration,
  CafeInterfaceCopy,
  CafeProductConfiguration,
  CafeProductSelection,
  CafeSelection,
  ShippingBasket,
  StorefrontState,
} from "./storefront-types.ts";
import {
  QuantityStepper,
  cafeBasketHasItems,
  cafeBasketItemCount,
  cafeBasketLines,
  cafeBasketModifiers,
  cafeBasketQuantity,
  cafeBasketTotal,
  cafeCategoryItemCount,
  cafeInterfaceCopy,
  cafeItemCopy,
  cafeMenuItemCount,
  cafeProductPreparation,
  cafeSelection,
  initialCafeBasket,
  initialShippingBasket,
  isAvailableShippingService,
  money,
  publishedMenuSections,
  shippingBasketItem,
  shippingBasketSubtotal,
  shippingCountryCopy,
  shippingListingCount,
  shippingListingImage,
  shippingOrderLines,
  shippingOrderSummaryLines,
  shippingSelection,
  shippingServiceSelection,
  shippingServicesForCountry,
} from "./storefront-basket.tsx";
import {
  buyerContactPolicy,
  buyerContactPolicyCopy,
  buyerPhoneIsRequired,
  buyerPhoneIsVisible,
} from "./order-presentation.ts";
import {
  CafeFlavorMenu,
  CafeMenuItem,
  CafeModifierControls,
  EmptyCatalog,
  FeedbackView,
  FormField,
  MobileCheckoutBar,
} from "./storefront-views.tsx";
import { CAFE_FLAVOR_MENU_COPY } from "./cafe-copy.ts";
import {
  contactFieldError,
  normalizedShippingAddress,
  shippingAddressForCountry,
  shippingAddressSummary,
  shippingCountryOptions,
  shippingFieldError,
} from "./shipping-address.ts";

export const storefrontCatalogViews = {
  renderCafeCatalog(
    this: StorefrontApp,
    state: Variant<StorefrontState, "catalog">,
    config: CafeConfiguration,
  ): React.ReactNode {
    const selection = cafeSelection(state.context.catalog, config);
    const basket =
      state.context.basket.kind === "cafe"
        ? state.context.basket
        : initialCafeBasket();
    const hasItems = cafeBasketHasItems(basket);
    const copy = cafeInterfaceCopy(this.cafeLanguage);
    const contactPolicy = buyerContactPolicy(state.context.session);
    const shopName = config.showcase
      ? config.name
      : state.context.session.checkoutProfileConfiguration.presentationPolicy
          .merchantDisplayName;
    return (
      <div
        className={
          config.presentation === "patisserie"
            ? "cafe-app-shell patisserie-shell"
            : "cafe-app-shell"
        }
      >
        {selection.ok ? (
          <>
            {config.presentation === "patisserie" ? (
              this.renderPatisserieMenu(selection.value, basket, shopName)
            ) : config.presentation === "menu" ? (
              this.renderPublishedMenu(selection.value, basket, copy, shopName)
            ) : (
              <>
                <nav
                  className="cafe-category-rail"
                  aria-label={copy.categoryNavigationLabel}
                >
                  <a aria-current="page" href="#cafe-order-heading">
                    <span aria-hidden="true">⌂</span>
                    {copy.categoryMenu}
                  </a>
                  <a href="#cafe-drinks">
                    <span aria-hidden="true">○</span>
                    {copy.categoryDrinks}
                  </a>
                  <a href="#cafe-bakes">
                    <span aria-hidden="true">◇</span>
                    {copy.categoryBakes}
                  </a>
                  <a
                    className="cafe-cart-shortcut"
                    href="#pickup-summary-heading"
                  >
                    <span aria-hidden="true">□</span>
                    {copy.basketHeading}
                    <b>{cafeBasketItemCount(basket)}</b>
                  </a>
                </nav>
                <section
                  aria-labelledby="cafe-order-heading"
                  className="cafe-menu"
                >
                  <header className="cafe-app-intro">
                    <div>
                      <p className="eyebrow">{copy.welcome(shopName)}</p>
                      <h1 id="cafe-order-heading" tabIndex={-1}>
                        {copy.title}
                      </h1>
                      <p>{copy.introduction}</p>
                    </div>
                    <div className="pickup-note">
                      <span aria-hidden="true">●</span>
                      <strong>{copy.pickupOpen}</strong>
                      <small>{copy.pickupDetail}</small>
                    </div>
                  </header>
                  <div className="cafe-menu-heading">
                    <div>
                      <p className="eyebrow">{copy.menuEyebrow}</p>
                      <h2>{copy.menuHeading}</h2>
                    </div>
                    <span>
                      {cafeMenuItemCount(copy, selection.value.products.length)}
                    </span>
                  </div>
                  <section
                    className="cafe-menu-group"
                    id="cafe-drinks"
                    aria-labelledby="cafe-drinks-heading"
                  >
                    <div className="cafe-menu-group-heading">
                      <h3 id="cafe-drinks-heading">{copy.categoryDrinks}</h3>
                      <span>
                        {cafeCategoryItemCount(
                          copy,
                          selection.value.products,
                          "drink",
                        )}
                      </span>
                    </div>
                    <div className="cafe-product-grid">
                      {this.renderCafeProducts(
                        selection.value,
                        basket,
                        copy,
                        "drink",
                      )}
                    </div>
                  </section>
                  <section
                    className="cafe-menu-group"
                    id="cafe-bakes"
                    aria-labelledby="cafe-bakes-heading"
                  >
                    <div className="cafe-menu-group-heading">
                      <h3 id="cafe-bakes-heading">{copy.categoryBakes}</h3>
                      <span>
                        {cafeCategoryItemCount(
                          copy,
                          selection.value.products,
                          "bake",
                        )}
                      </span>
                    </div>
                    <div className="cafe-product-grid">
                      {this.renderCafeProducts(
                        selection.value,
                        basket,
                        copy,
                        "bake",
                      )}
                    </div>
                  </section>
                  <CafeFlavorMenu
                    copy={CAFE_FLAVOR_MENU_COPY[this.cafeLanguage]}
                    showcase={config.showcase}
                  />
                </section>
              </>
            )}
            {this.placeBasket(
              config,
              <aside
                className="cafe-basket"
                aria-labelledby="pickup-summary-heading"
              >
                <div className="cafe-basket-heading">
                  <div>
                    <p className="eyebrow">{copy.orderEyebrow}</p>
                    <h2 id="pickup-summary-heading">{copy.basketHeading}</h2>
                  </div>
                  <span className="basket-count">
                    {cafeBasketItemCount(basket)}
                  </span>
                </div>
                {hasItems ? (
                  <ul className="basket-summary">
                    {cafeBasketLines(
                      basket,
                      selection.value,
                      this.cafeLanguage,
                      copy,
                      this.decreaseCafeQuantity,
                      this.increaseCafeQuantity,
                    )}
                  </ul>
                ) : (
                  <p className="empty-basket">{copy.emptyBasket}</p>
                )}
                {hasItems ? (
                  <div className="basket-total">
                    <span>{copy.estimatedTotal}</span>
                    <strong>
                      {money(cafeBasketTotal(basket, selection.value))}
                    </strong>
                  </div>
                ) : null}
                <form
                  id="cafe-checkout-contact"
                  noValidate
                  onSubmit={this.createCafeQuote}
                >
                  <p className="basket-footnote">
                    {buyerContactPolicyCopy(contactPolicy, this.cafeLanguage)}
                  </p>
                  <FormField
                    id="cafeEmail"
                    label="Email"
                    type="email"
                    autoComplete="email"
                    placeholder="name@example.com"
                    error={contactFieldError(
                      this.cafeContactSubmitted,
                      "email",
                      basket.buyerContact.email,
                      contactPolicy,
                    )}
                    value={basket.buyerContact.email}
                    onChange={this.changeBuyerEmail}
                  />
                  {buyerPhoneIsVisible(contactPolicy) ? (
                    <FormField
                      id="cafePhone"
                      label={
                        buyerPhoneIsRequired(contactPolicy)
                          ? "Phone"
                          : "Phone (optional)"
                      }
                      type="tel"
                      autoComplete="tel"
                      pattern="\+[1-9][0-9]{7,14}"
                      placeholder="+819012345678"
                      hint="Include + and the country code."
                      error={contactFieldError(
                        this.cafeContactSubmitted,
                        "phone",
                        basket.buyerContact.phone,
                        contactPolicy,
                      )}
                      value={basket.buyerContact.phone}
                      onChange={this.changeBuyerPhone}
                      required={buyerPhoneIsRequired(contactPolicy)}
                    />
                  ) : null}
                  <button
                    className="primary-button"
                    type="submit"
                    disabled={!hasItems}
                  >
                    {copy.checkout}
                  </button>
                  <p className="basket-footnote">{copy.checkoutDetail}</p>
                </form>
              </aside>,
            )}
            {hasItems && !this.cartOpen ? (
              <MobileCheckoutBar
                count={cafeBasketItemCount(basket)}
                label={copy.basketHeading}
                total={money(cafeBasketTotal(basket, selection.value))}
                onOpen={
                  config.presentation === "patisserie"
                    ? this.openCart
                    : undefined
                }
              />
            ) : null}
          </>
        ) : (
          <EmptyCatalog message={selection.message} />
        )}
        <FeedbackView feedback={state.feedback} />
      </div>
    );
  },

  /** The basket: a column on the café page, a drawer on the pâtisserie site. */
  placeBasket(
    this: StorefrontApp,
    config: CafeConfiguration,
    basket: React.ReactNode,
  ): React.ReactNode {
    if (config.presentation !== "patisserie") return basket;
    const copy = cafeInterfaceCopy(this.cafeLanguage);
    return (
      <CartDrawer
        open={this.cartOpen}
        label={copy.basketHeading}
        closeLabel={this.cafeLanguage === "ja" ? "閉じる" : "Close"}
        onClose={this.closeCart}
      >
        {basket}
      </CartDrawer>
    );
  },

  renderPatisserieMenu(
    this: StorefrontApp,
    selection: CafeSelection,
    basket: CafeBasket,
    shopName: string,
  ): React.ReactNode {
    const items: PatisserieMenuItem[] = [];
    for (const product of selection.products) {
      const patisserie = patisserieProduct(product.config.menuEntryId);
      if (patisserie === undefined) continue;
      items.push({
        slug: patisserie.slug,
        price: money(product.entry.price),
        available: product.entry.availability === "available",
        quantity: cafeBasketQuantity(basket, product.config.menuEntryId),
      });
    }
    const copy = cafeInterfaceCopy(this.cafeLanguage);
    const orderStatusHref = this.orderStatusHref();
    return (
      <section
        aria-label={copy.menuHeading}
        className="cafe-menu patisserie-page"
      >
        <header className="patisserie-masthead">
          <h1 id="cafe-order-heading" tabIndex={-1}>
            {shopName}
          </h1>
          <p>{patisserieMastheadDetail(this.cafeLanguage)}</p>
        </header>
        <PatisserieMenu
          language={this.cafeLanguage}
          items={items}
          shopNav={{
            cartLabel: copy.basketHeading,
            cartCount: cafeBasketItemCount(basket),
            cartOpen: this.cartOpen,
            onOpenCart: this.openCart,
            ...(orderStatusHref === undefined
              ? {}
              : {
                  orderStatus: {
                    href: orderStatusHref,
                    label: copy.orderStatusNav,
                  },
                }),
          }}
          onIncrease={this.increaseCafeQuantity}
          onDecrease={this.decreaseCafeQuantity}
        />
      </section>
    );
  },

  /**
   * A shop's QR order page: its name, then each section of its published
   * menu with the section's items. No demo copy shows.
   */
  renderPublishedMenu(
    this: StorefrontApp,
    selection: CafeSelection,
    basket: CafeBasket,
    copy: CafeInterfaceCopy,
    shopName: string,
  ): React.ReactNode {
    const sections = publishedMenuSections(selection, copy.categoryMenu);
    const menuNames = [
      ...new Set(selection.products.map((product) => product.menu.name)),
    ];
    return (
      <>
        <nav
          className="cafe-category-rail"
          aria-label={copy.categoryNavigationLabel}
        >
          <a aria-current="page" href="#cafe-order-heading">
            <span aria-hidden="true">⌂</span>
            {copy.categoryMenu}
          </a>
          {sections.map((section) => (
            <a key={section.anchor} href={`#${section.anchor}`}>
              <span aria-hidden="true">○</span>
              {section.name}
            </a>
          ))}
          <a className="cafe-cart-shortcut" href="#pickup-summary-heading">
            <span aria-hidden="true">□</span>
            {copy.basketHeading}
            <b>{cafeBasketItemCount(basket)}</b>
          </a>
        </nav>
        <section aria-labelledby="cafe-order-heading" className="cafe-menu">
          <header className="cafe-app-intro">
            <div>
              <h1 id="cafe-order-heading" tabIndex={-1}>
                {shopName}
              </h1>
            </div>
            <div className="pickup-note">
              <span aria-hidden="true">●</span>
              <strong>{copy.pickupOpen}</strong>
              <small>{copy.pickupDetail}</small>
            </div>
          </header>
          <div className="cafe-menu-heading">
            <div>
              <p className="eyebrow">{copy.menuEyebrow}</p>
              <h2>{menuNames.join(" · ")}</h2>
            </div>
            <span>{cafeMenuItemCount(copy, selection.products.length)}</span>
          </div>
          {sections.map((section) => (
            <section
              className="cafe-menu-group"
              id={section.anchor}
              key={section.anchor}
              aria-labelledby={`${section.anchor}-heading`}
            >
              <div className="cafe-menu-group-heading">
                <h3 id={`${section.anchor}-heading`}>{section.name}</h3>
                <span>{cafeMenuItemCount(copy, section.products.length)}</span>
              </div>
              <div className="cafe-product-grid">
                {section.products.map((product) =>
                  this.renderCafeProduct(product, basket, copy, section.name),
                )}
              </div>
            </section>
          ))}
        </section>
      </>
    );
  },

  renderCafeProducts(
    this: StorefrontApp,
    selection: CafeSelection,
    basket: CafeBasket,
    copy: CafeInterfaceCopy,
    category: CafeProductConfiguration["category"],
  ): readonly React.ReactNode[] {
    const products: React.ReactNode[] = [];
    for (const product of selection.products) {
      if (product.config.category === category)
        products.push(this.renderCafeProduct(product, basket, copy));
    }
    return products;
  },

  renderCafeProduct(
    this: StorefrontApp,
    product: CafeProductSelection,
    basket: CafeBasket,
    copy: CafeInterfaceCopy,
    /** The menu section's name; the demo shows drinks or bakes. */
    category?: string,
  ): React.ReactNode {
    const productCopy = cafeItemCopy(this.cafeLanguage, product.config);
    const quantity = cafeBasketQuantity(basket, product.config.menuEntryId);
    const preparation = cafeProductPreparation(
      copy,
      product.config.preparation,
    );
    return (
      <CafeMenuItem
        key={product.config.menuEntryId}
        id={product.config.menuEntryId}
        itemKey={product.config.menuEntryId}
        flavor={product.config.flavor}
        imageUrl={product.config.imageUrl}
        imageAlt={product.config.imageAlt}
        category={
          category ??
          (product.config.category === "drink"
            ? copy.categoryDrinks
            : copy.categoryBakes)
        }
        title={productCopy.title}
        description={productCopy.description}
        allergenLine={
          productCopy.allergens.length === 0
            ? undefined
            : `${copy.containsLabel}: ${productCopy.allergens}`
        }
        preparationLabel={preparation.label}
        timingLabel={preparation.timing}
        price={product.entry.price}
        availability={product.entry.availability}
        soldOutLabel={copy.soldOut}
        addVisibleLabel={copy.addAction}
        addLabel={`${copy.addOne} ${productCopy.title}`}
        removeLabel={`${copy.removeOne} ${productCopy.title}`}
        selectedLabel={copy.selected}
        quantity={quantity}
        onDecrease={this.decreaseCafeQuantity}
        onIncrease={this.increaseCafeQuantity}
      >
        <CafeModifierControls
          menuEntryId={product.config.menuEntryId}
          groups={product.entry.modifierGroups}
          selectedOptionIds={cafeBasketModifiers(
            basket,
            product.config.menuEntryId,
          )}
          disabled={product.entry.availability === "unavailable"}
          language={this.cafeLanguage}
          label={
            product.config.flavor === "menu"
              ? product.entry.modifierGroups
                  .map((group) => group.name)
                  .join(" · ")
              : copy.milkChoice
          }
          onChange={this.changeCafeModifier}
        />
      </CafeMenuItem>
    );
  },

  renderShippingCatalog(
    this: StorefrontApp,
    state: Variant<StorefrontState, "catalog">,
  ): React.ReactNode {
    const catalog = state.context.catalog;
    const basket =
      state.context.basket.kind === "shipping"
        ? state.context.basket
        : initialShippingBasket(catalog);
    const selection = shippingSelection(catalog, basket);
    const serviceSelection = shippingServiceSelection(catalog, basket);
    const shippingServices = shippingServicesForCountry(
      catalog,
      basket.address.countryCode,
    );
    const deliveryAvailable = shippingServices.some(isAvailableShippingService);
    const orderLines = selection.ok
      ? shippingOrderLines(selection.value, basket)
      : [];
    const countryCopy = shippingCountryCopy(basket.address.countryCode);
    const contactPolicy = buyerContactPolicy(state.context.session);
    return (
      <div className="shipping-store">
        <section className="shipping-hero">
          <div>
            <p className="eyebrow">From Tokyo, with care</p>
            <h1 tabIndex={-1}>Small-batch treats, ready to travel</h1>
            <p>{countryCopy.heroDetail}</p>
            <div className="shipping-hero-actions">
              <a
                className="primary-button shipping-hero-cta"
                href="#shipping-catalog-heading"
              >
                Shop gift boxes
              </a>
            </div>
          </div>
          <img
            src="/products/nuki-neko-madeleines.webp"
            alt="Five golden cat-shaped madeleines on a cream ceramic plate"
            width={1448}
            height={1086}
          />
        </section>
        {catalog.listings.length === 0 ? (
          <EmptyCatalog
            message="No gift boxes are published right now."
            actionLabel="Check again"
            onAction={this.retryBootstrap}
          />
        ) : (
          <div className="shipping-layout">
            <section
              className="shipping-catalog"
              aria-labelledby="shipping-catalog-heading"
            >
              <div className="shipping-catalog-heading">
                <div>
                  <p className="eyebrow">Baked in Japan</p>
                  <h2 id="shipping-catalog-heading">Choose your gift box</h2>
                </div>
                <span>{shippingListingCount(catalog.listings.length)}</span>
              </div>
              <p className="shipping-selection-guide">
                Select gift boxes for this delivery. You can order up to 12
                boxes of each selected style.
              </p>
              <div className="shipping-catalog-grid">
                {this.renderShippingListings(catalog, basket)}
              </div>
              <ul className="shipping-benefits">
                <li>Six handmade cookies in every box</li>
                <li>
                  Carrier service and estimated delivery dates confirmed in your
                  quote
                </li>
                <li>Shipping, duty, and tax shown before payment</li>
                <li>All prices shown in Japanese yen</li>
                <li>Contains wheat, dairy, egg, and almond</li>
              </ul>
            </section>
            <form
              className="address-form"
              id="shipping-delivery"
              aria-labelledby="shipping-delivery-heading"
              noValidate
              onSubmit={this.createShippingQuote}
            >
              <div>
                <p className="eyebrow">Checkout</p>
                <h2 id="shipping-delivery-heading">
                  {countryCopy.deliveryHeading}
                </h2>
                <p>{countryCopy.deliveryDetail}</p>
              </div>
              {selection.ok ? (
                <div className="shipping-order-lines">{orderLines}</div>
              ) : (
                <p className="shipping-order-empty">{selection.message}</p>
              )}
              <div className="shipping-destination-summary">
                <label htmlFor="shippingCountry">Delivery country</label>
                <select
                  id="shippingCountry"
                  name="shippingCountry"
                  value={basket.address.countryCode}
                  onChange={this.changeShippingCountry}
                >
                  {shippingCountryOptions(
                    catalog,
                    basket.address.countryCode,
                  ).map((country) => (
                    <option key={country} value={country}>
                      {shippingCountryCopy(country).name}
                    </option>
                  ))}
                </select>
                <small>{countryCopy.destinationDetail}</small>
              </div>
              {shippingServices.length > 0 ? (
                <fieldset className="shipping-service-options">
                  <legend>Delivery service</legend>
                  <p>
                    {deliveryAvailable
                      ? "Select how this order should ship. Your quote confirms the price and delivery dates."
                      : "Delivery is temporarily unavailable. Try again later."}
                  </p>
                  <div>
                    {this.renderShippingServiceOptions(
                      shippingServices,
                      basket.shippingServiceCode,
                    )}
                  </div>
                </fieldset>
              ) : (
                <p className="shipping-order-empty">{countryCopy.noServices}</p>
              )}
              {deliveryAvailable ? (
                <>
                  <p className="basket-footnote">
                    {buyerContactPolicyCopy(contactPolicy, this.cafeLanguage)}
                  </p>
                  <FormField
                    id="shippingEmail"
                    label="Email"
                    type="email"
                    autoComplete="email"
                    placeholder="name@example.com"
                    error={contactFieldError(
                      this.shippingFormSubmitted,
                      "email",
                      basket.buyerContact.email,
                      contactPolicy,
                    )}
                    value={basket.buyerContact.email}
                    onChange={this.changeBuyerEmail}
                  />
                  {buyerPhoneIsVisible(contactPolicy) ? (
                    <FormField
                      id="shippingPhone"
                      label={
                        buyerPhoneIsRequired(contactPolicy)
                          ? "Phone"
                          : "Phone (optional)"
                      }
                      type="tel"
                      autoComplete="tel"
                      pattern="\+[1-9][0-9]{7,14}"
                      placeholder="+819012345678"
                      hint="Include + and the country code."
                      error={contactFieldError(
                        this.shippingFormSubmitted,
                        "phone",
                        basket.buyerContact.phone,
                        contactPolicy,
                      )}
                      value={basket.buyerContact.phone}
                      onChange={this.changeBuyerPhone}
                      required={buyerPhoneIsRequired(contactPolicy)}
                    />
                  ) : null}
                  <FormField
                    id="recipientName"
                    label="Recipient name"
                    autoComplete="shipping name"
                    error={shippingFieldError(
                      this.shippingFormSubmitted,
                      "recipientName",
                      basket.address,
                    )}
                    value={basket.address.recipientName}
                    onChange={this.changeRecipientName}
                  />
                  <FormField
                    id="addressLine1"
                    label="Street address"
                    autoComplete="shipping address-line1"
                    error={shippingFieldError(
                      this.shippingFormSubmitted,
                      "addressLine1",
                      basket.address,
                    )}
                    value={basket.address.addressLine1}
                    onChange={this.changeAddressLine1}
                  />
                  {basket.address.countryCode !== "SG" ? (
                    <FormField
                      id="shippingLocality"
                      label={countryCopy.localityLabel}
                      autoComplete="shipping address-level2"
                      error={shippingFieldError(
                        this.shippingFormSubmitted,
                        "locality",
                        basket.address,
                      )}
                      value={basket.address.locality}
                      onChange={this.changeShippingLocality}
                    />
                  ) : null}
                  {basket.address.administrativeArea !== undefined ? (
                    <FormField
                      id="shippingAdministrativeArea"
                      label={countryCopy.areaLabel}
                      autoComplete="shipping address-level1"
                      error={shippingFieldError(
                        this.shippingFormSubmitted,
                        "administrativeArea",
                        basket.address,
                      )}
                      value={basket.address.administrativeArea}
                      onChange={this.changeShippingAdministrativeArea}
                    />
                  ) : null}
                  <FormField
                    id="postalCode"
                    label={countryCopy.postalLabel}
                    autoComplete="shipping postal-code"
                    inputMode={countryCopy.postalInputMode}
                    pattern={countryCopy.postalPattern}
                    hint={countryCopy.postalHint}
                    error={shippingFieldError(
                      this.shippingFormSubmitted,
                      "postalCode",
                      basket.address,
                    )}
                    value={basket.address.postalCode}
                    onChange={this.changePostalCode}
                  />
                  <button className="primary-button" type="submit">
                    Continue to delivery quote
                  </button>
                </>
              ) : null}
            </form>
          </div>
        )}
        {selection.ok && serviceSelection.ok ? (
          <aside
            className="shipping-mobile-summary"
            aria-label="Selected gift boxes"
          >
            <div>
              <ul className="shipping-mobile-summary-lines">
                {shippingOrderSummaryLines(selection.value, basket)}
              </ul>
              <small>
                Items subtotal{" "}
                {money(shippingBasketSubtotal(selection.value, basket))}
              </small>
            </div>
            <button
              className="primary-button"
              type="submit"
              form="shipping-delivery"
            >
              Continue
            </button>
          </aside>
        ) : null}
        <FeedbackView feedback={state.feedback} />
      </div>
    );
  },

  renderShippingAddressCorrection(
    this: StorefrontApp,
    state: Variant<StorefrontState, "shipping_address_correction">,
  ): React.ReactNode {
    if (state.context.basket.kind !== "shipping") return null;
    const entered = normalizedShippingAddress(state.context.basket.address);
    const proposed = shippingAddressForCountry(
      state.validation.proposedAddress,
      state.context.basket.address.countryCode,
    );
    if (proposed === undefined) return null;
    const countryCopy = shippingCountryCopy(
      state.context.basket.address.countryCode,
    );
    return (
      <section
        className="status-card"
        aria-labelledby="address-correction-heading"
      >
        <p className="eyebrow">Review delivery address</p>
        <h1 id="address-correction-heading" tabIndex={-1}>
          Use the suggested address?
        </h1>
        <p>{countryCopy.correctionDetail}</p>
        <div className="address-correction-comparison">
          <section aria-labelledby="entered-address-heading">
            <h2 id="entered-address-heading">As entered</h2>
            <address>{shippingAddressSummary(entered)}</address>
          </section>
          <section aria-labelledby="suggested-address-heading">
            <h2 id="suggested-address-heading">Suggested address</h2>
            <address>{shippingAddressSummary(proposed)}</address>
          </section>
        </div>
        <div className="status-actions">
          <button
            className="primary-button"
            type="button"
            onClick={this.acceptShippingAddressCorrection}
          >
            Use suggested address
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={this.editShippingAddressCorrection}
          >
            Edit address
          </button>
        </div>
      </section>
    );
  },

  renderShippingListings(
    this: StorefrontApp,
    catalog: CommerceBuyerCatalogV1,
    basket: ShippingBasket,
  ): readonly React.ReactNode[] {
    const items: React.ReactNode[] = [];
    for (const listing of catalog.listings)
      items.push(this.renderShippingListing(listing, basket));
    return items;
  },

  renderShippingServiceOptions(
    this: StorefrontApp,
    services: readonly CommerceBuyerShippingServiceV1[],
    selectedServiceCode: string | undefined,
  ): readonly React.ReactNode[] {
    const options: React.ReactNode[] = [];
    for (const service of services) {
      const available = isAvailableShippingService(service);
      options.push(
        <label key={`${service.destinationCountry}:${service.service.code}`}>
          <input
            type="radio"
            name="shippingServiceCode"
            value={service.service.code}
            checked={service.service.code === selectedServiceCode}
            onChange={this.changeShippingService}
            disabled={!available}
          />
          <span>
            {available
              ? service.service.name
              : `${service.service.name} — Temporarily unavailable`}
          </span>
        </label>,
      );
    }
    return options;
  },

  renderShippingListing(
    this: StorefrontApp,
    listing: CommerceBuyerCatalogListingV1,
    basket: ShippingBasket,
  ): React.ReactNode {
    const image = shippingListingImage(listing);
    const available = listing.availability === "available";
    const item = shippingBasketItem(basket, listing.variantId);
    const selected = available && item !== undefined;
    return (
      <article
        key={listing.variantId}
        className={`shipping-product shipping-catalog-item shipping-catalog-item-${listing.availability}${selected ? " shipping-catalog-item-selected" : ""}`}
      >
        <div className="shipping-catalog-media">
          <img
            src={image.imageUrl}
            alt={image.imageAlt}
            width={1448}
            height={1086}
            loading="lazy"
          />
          {available ? (
            selected ? (
              <span className="shipping-selected-badge">✓ Selected</span>
            ) : null
          ) : (
            <span>Sold out</span>
          )}
        </div>
        <div className="shipping-product-copy">
          <p className="eyebrow">Baked in Japan</p>
          <h3>{listing.title}</h3>
          <p>{listing.description}</p>
          <div className="shipping-price">
            <strong>{money(listing.price)}</strong>
            {available ? <span>In stock</span> : null}
          </div>
          <QuantityStepper
            itemKey={listing.variantId}
            label={listing.title}
            addVisibleLabel="Select box"
            addLabel={`Choose the ${listing.title}`}
            removeLabel={`Remove one ${listing.title}`}
            selectedLabel="selected"
            value={selected && item !== undefined ? item.quantity : 0}
            minimum={0}
            maximum={available ? 12 : 0}
            onDecrease={this.decreaseShippingQuantity}
            onIncrease={this.increaseShippingQuantity}
          />
        </div>
      </article>
    );
  },
};

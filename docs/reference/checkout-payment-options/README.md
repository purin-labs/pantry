# Reference: a checkout with several payment options

This file is a design reference for the Purin Checkout pages.
[Plan 77](../../history/plan-77-underclerk-modular-core.md) owns the payments module
and the checkout pipeline. The operator supplied the file on 20 November 2026.

Use the structure of this screen. Do not copy the names, the brand, the text
or the assets of Cloudflare or of the payment providers. The file is
third-party material. Keep it inside this repository and do not publish it.

Two grey bars cover the email address of the account and the last four digits
of the card. The original screen shows text in those two places.

## The screenshot

| File                                                             | What it shows                                                                                  |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [01-cloudflare-activate-r2.webp](01-cloudflare-activate-r2.webp) | The "Activate R2" billing page of Cloudflare: payment on the left, order summary on the right. |

## What makes it a good example

- The wallet buttons come first: Apple Pay, Google Pay and PayPal. Each button
  has the full width, the same height and the colours of its own brand.
- The Google Pay button shows the saved cards inside the button, with a "+"
  for a new card.
- An "OR" divider separates the wallet buttons from the saved payment method.
- The saved payment method is one row: the account, the card name and the last
  four digits. A chevron opens the other cards, and a "…" menu holds the
  account actions.
- The consent sentence is directly below the payment method, before the
  billing address.
- The billing address is one joined group of fields, not separate boxes.
  Optional fields say "(optional)" in the placeholder.
- A "Secure billing" label with a lock is above the page title.
- The order summary stays in a separate card. It lists the plan price, the
  included amounts with check marks, the overage rates, and then "Due today"
  with a short note below it.
- A close button is at the top right of the page. The page has no other
  navigation.

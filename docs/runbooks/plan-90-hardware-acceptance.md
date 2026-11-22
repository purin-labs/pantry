# Plan 90 — hardware and live acceptance

The software of Plan 90 is built and proven with fakes and simulators. The
steps in this runbook need hardware, a live provider account or a document
from a provider. The owner does them, or approves each live charge first.

| Step                                     | Needs                                                               | Proves                                                   |
| ---------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------- |
| A. Square app on an iPad (Phase 3B live) | iPad, Square Reader, live Japan Square location                     | The handoff, the readback and the refunds on real Square |
| B. Square Terminal (Phase 3C)            | Square Terminal, live Japan Square location                         | Plan 33D physical acceptance on the commerce engine      |
| C. GMO `stera` (Phase 4B)                | The POS-link specification from SMBC and GMO-FG, a `stera terminal` | The LAN framing in `crates/shop-gateway`                 |
| D. Receipt printer (Phase 5)             | Star `MCP31LB`, optional `mJ-Drawer`                                | Printing and the drawer kick on real hardware            |

Use small test sales (one ¥100 item) and refund each one. Record each sale in
`docs/evidence/plan-90-<step>-<date>.md`: the Pantry order id, the provider
payment id, the tender, the refund and what the Register showed.

## A. Square app on an iPad (Phase 3B live)

Square's Sandbox has no Point of Sale API, so the first real check is a live
sale.

1. In the Square Developer Console, open the production application that
   Pantry uses. Under Point of Sale API, add the web callback URL that
   Café › Counters & payments shows in "Use the Square app on an iPad". It is
   `<Portal origin>/portal/square-pos-return`.
2. In Square, apply for e-money and PayPay for the location. Square must
   approve these tenders before the app offers them.
3. On the iPad, install Square Point of Sale, sign in to the café location
   and pair the Square Reader.
4. In Café › Counters & payments, choose the counter and the Square location,
   then select "Use the Square app".
5. On the same iPad, open the Register in Safari and do these sales:
   1. Card: "Card or e-money", pay with a card. The Register shows the
      pickup code. Refund the order in Pantry; Square shows the refund.
   2. Suica: "Card or e-money", tap Suica. Pantry records FeliCa. Refund it in
      cash at the counter; Pantry sends no refund to Square.
   3. PayPay: "PayPay", scan with PayPay. Refund it in Pantry.
   4. Cancel: open the app and cancel there. The Register shows the sale as
      declined, and "Switch to cash" works.
6. If one check fails, keep the iPad as it is and send the evidence file.

Limits that stay after this step:

- If the app does not return to the Register (for example, the barista closes
  Safari), Pantry has no transaction id. The sale stays open. Find the payment
  in the Square Dashboard, refund it there, and ring up the sale again.
- In Square's Offline Mode, the app returns no transaction id. The sale stays
  open for the same check.

## B. Square Terminal (Phase 3C)

This restarts the physical acceptance of
[Plan 33D](../history/plan-33D-square-release-acceptance.md) ("Deferred until resumed
by the user", item 2) on the commerce engine.

1. Activate the Japan Square location for live payments, with e-money and
   PayPay.
2. Buy one Square Terminal. In Café › Counters & payments, pair it with the
   code that Pantry shows.
3. Do these sales on the Register: card, FeliCa (Suica, then a cash refund),
   QR (PayPay, then a refund), a cancel on the Terminal, and a network cut
   during a payment (unplug the Terminal's network, reconnect, then "Check
   terminal").
4. Check that each Pantry receipt agrees with the Square receipt.
5. Retire the Terminal in Counters & payments and pair it again.

## C. GMO `stera` (Phase 4B)

Pantry builds no `stera` LAN framing before the official specification
arrives (Plan 90 D7). The simulator of Phase 4A stays the test path.

1. Ask SMBC (`stera developers`) and GMO Financial Gate
   (`pos_stera@gmo-fg.com`) for the LAN POS-link (CCT) specification. Say that
   a café in Japan connects one `stera terminal` to its own POS over the shop
   LAN, for card, transit IC, other e-money and QR, with cancellation, inquiry
   and refunds.
2. When the specification arrives, add it to `docs/equipment/` with
   `node scripts/repo-binaries.mjs upload <path>` and start Phase 4B.
3. Phase 4B ends with a physical certification: card, transit IC with a cash
   refund, QR, a cancel race, a LAN cut during a tap and a gateway restart.

## D. Receipt printer (Phase 5)

The gateway setup is in `services/shop-gateway/README.md` ("Receipt printer
and cash drawer").

1. Give the `MCP31LB` a fixed address on the shop LAN. Connect the
   `mJ-Drawer` to the printer's DK port.
2. Add the printer to `printers.json` in the gateway's folder, with
   `"drawer": true`, and restart the gateway.
3. On the Devices page, confirm the printer.
4. On the Register, do a cash sale: one receipt prints and the drawer opens
   once. Check the Japanese text, the 8 % and 10 % tax lines, the
   registration number and the pickup code.
5. Do a manual cash refund: the drawer opens once.
6. Check the faults: no paper, cover open, a power cut during a print and a
   LAN cut. Each one shows on the Register and the Devices page, and no sale
   changes. After the fault, a repeated print does not print twice.

/**
 * Long task descriptions for the basic seed, written the way an agent writes a thorough one: prose next to wide and
 * narrow tables, code blocks with long lines, nested lists, task lists, every alert type and footnotes. They exist to
 * judge how the task window lays out a long document (its width, wide tables, code that scrolls).
 */

/** A design doc: long prose, a wide comparison table, a code block wider than the prose and a task list. */
export const CART_DRAWER_DESIGN = `## Problem

Every quantity change in the cart drawer re-renders the whole product page. On a mid-range Android phone a single tap on **+** takes around 180 ms to paint, and holding the button down queues up taps faster than the page can keep up, so the count jumps by three or four at once. The drawer reads the cart straight from the page's top-level state, which is why a change anywhere in it invalidates everything below the layout.

The drawer also owns the promo code logic, so the payment step can't validate a code without opening the drawer first. That's the bug behind codes failing on the payment step.

> [!NOTE]
> This rewrite keeps the drawer's look exactly as it is. Visual changes go in a follow-up once the store is in place, so the before and after can be compared in one screenshot.

## Goals

1. A quantity change re-renders only the line item and the totals.
2. Promo codes validate in the store, so any step can apply one.
3. The drawer opens with the cart already loaded, with no spinner, even on a cold page load.

### Non-goals

- Server-side cart persistence. The cart stays in \`localStorage\` for guests.
- Changing the add-to-cart button on the product page.

## Options considered

| Option | Re-renders on a quantity change | Bundle cost | Migration effort | Works with server components | Notes |
| --- | --- | --- | --- | --- | --- |
| Keep page state, memoize the drawer | Drawer and totals | None | Small | Yes | Memo boundaries break as soon as someone passes an inline callback, and we have six of them today |
| React context per cart | Every consumer of the context | None | Medium | Partly | Context changes still re-render every consumer; we'd need to split it into three contexts to get close |
| External store with selectors | Only the subscribed line item and the totals | ~1.2 kB | Medium | Yes | What the account page already does, so there's a pattern to copy |
| Move the cart into a URL param | Whole page (navigation) | None | Large | Yes | Shareable carts are nice, but the URL gets long and analytics would count every change as a page view |

We're going with the **external store with selectors**. It's the only option where a change to one line item can't re-render another, and the account page has run on the same pattern for a year without trouble.

## Sketch

\`\`\`ts
export const cartStore = createStore<CartState>()((set, get) => ({
  lines: [],
  setQuantity: (sku: string, quantity: number) => set((state) => ({ lines: state.lines.map((line) => (line.sku === sku ? { ...line, quantity: Math.max(0, Math.min(quantity, line.maxPerOrder)) } : line)) })),
  applyPromo: async (code: string) => {
    const result = await validatePromo(code, get().lines);
    set({ promo: result.ok ? result.promo : null, promoError: result.ok ? null : result.reason });
  },
}));
\`\`\`

A line item subscribes to its own line only:

\`\`\`tsx
const line = useCartStore((state) => state.lines.find((l) => l.sku === sku));
\`\`\`

## Rollout

- [x] Land the store behind the \`cart-store\` flag
- [x] Move quantity updates into the store
- [ ] Render the drawer's line items from the store
- [ ] Move promo codes into the store
  - [ ] Validate on apply, not on open
  - [ ] Show the error under the field rather than in a toast
- [ ] Remove the old drawer and the flag

> [!WARNING]
> The old drawer and the new one must not be mounted at the same time: both write to \`localStorage\` and the last writer wins.

## Open questions

1. Should an out-of-stock line stay in the cart greyed out, or be removed with a notice? Support prefers the first[^support].
2. Do we cap quantity at \`maxPerOrder\` silently, or say why the **+** button stopped working?

[^support]: From the support team's notes on last quarter's tickets: customers who lost an item from their cart without a notice were the second most common complaint.
`;

/** An incident write-up: a timeline table, logs with very long lines, and a narrow table. */
export const REFUNDS_RATE_LIMIT = `## What happened

On Tuesday a partner's retry loop sent about 40,000 refund requests in twelve minutes. The endpoint has no rate limit, so every request reached the payment provider, which started rejecting **all** our refund calls, including legitimate ones from the support dashboard, for the next 25 minutes.

> [!CAUTION]
> Until this ships, the only protection is the partner's own fix. Don't rotate their API key without telling them, or their retry loop starts again from zero.

## Timeline

| Time (UTC) | Event | Who noticed |
| --- | --- | --- |
| 14:02 | Partner deploys a change that retries any non-2xx refund response immediately, with no backoff | Nobody yet |
| 14:05 | Refund volume reaches 50× the usual rate | Dashboards, no alert configured |
| 14:14 | Provider returns \`429 Too Many Requests\` for every call, including the support dashboard's | Support, from a customer on chat |
| 14:21 | On-call blocks the partner's key at the gateway | On-call |
| 14:39 | Provider lifts its block | Provider status page |

## Logs

The provider's response, from the gateway log:

\`\`\`
2026-11-10T14:14:07.412Z WARN  refunds.create partner=acme-marketplace order=ord_8f2k1x amount=1999 currency=NZD provider_status=429 provider_body={"error":{"type":"rate_limit_error","message":"Too many refund requests for this account. Retry after 1500 seconds."}} attempt=7 latency_ms=84
2026-11-10T14:14:07.415Z WARN  refunds.create partner=acme-marketplace order=ord_8f2k1x amount=1999 currency=NZD provider_status=429 provider_body={"error":{"type":"rate_limit_error","message":"Too many refund requests for this account. Retry after 1500 seconds."}} attempt=8 latency_ms=79
\`\`\`

## Fix

Rate-limit per API key with a token bucket in Redis, and return \`429\` with a \`Retry-After\` header so well-behaved clients back off.

| Client | Limit |
| --- | --- |
| Partner keys | 10/s, burst 50 |
| Support dashboard | 50/s |
| Internal jobs | None |

> [!IMPORTANT]
> The support dashboard gets its own bucket. Whatever a partner does, support must still be able to refund a customer.

### Also

- Alert when refund volume passes 5× the hourly median.
- Write to the partner about backoff; link them to the API docs' [retry guidance](https://example.com/docs/api/errors#retrying-requests-safely-with-exponential-backoff-and-jitter).
`;

/** A spec with nested lists, a many-column table that has to scroll, and a long unbroken word. */
export const INVOICE_PDFS_SPEC = `## Summary

Invoices are always rendered in English, whatever language the customer shops in. Render them in the customer's language, falling back to English for the 4 languages our translators don't cover yet.

> [!TIP]
> The storefront already stores the customer's locale on the order (\`order.locale\`), so nothing new needs to be collected at checkout.

## What changes on the invoice

- **Labels**: "Invoice", "Due date", "Subtotal", "Tax" and the rest come from the translation files.
- **Dates**: formatted with \`Intl.DateTimeFormat\` in the order's locale.
  - The due date keeps the long form ("14 December 2026") so it can't be misread across locales.
  - The issue date can use the short form.
- **Amounts**: formatted with \`Intl.NumberFormat\` in the order's currency *and* locale, so \`1.234,50 €\` in German and \`€1,234.50\` in Irish English.
- **Legal text**: the footer is per country, not per language. A French-speaking customer in Belgium gets the Belgian footer in French.

## Locale coverage

| Locale | Labels | Dates | Amounts | Legal footer | Right-to-left | Font with the glyphs | Translator | Reviewed by legal | Ready |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| en-NZ | Yes | Yes | Yes | Yes | No | Inter | n/a | Yes | Yes |
| de-DE | Yes | Yes | Yes | Yes | No | Inter | Agency | Yes | Yes |
| fr-BE | Yes | Yes | Yes | Draft | No | Inter | Agency | No | No |
| ja-JP | Yes | Yes | Yes | No | No | Noto Sans JP | Agency | No | No |
| ar-AE | No | Yes | Yes | No | Yes | Noto Sans Arabic | Not booked | No | No |

The PDF renderer is configured with \`fontFallbackChainForInvoiceRenderingWhenTheCustomerLocaleNeedsGlyphsOutsideLatin1\`, which is a long name but at least it says what it does.

## Out of scope

1. Credit notes. They use a different template and come later.
2. Letting the customer pick a language for an invoice that was already sent.
`;

/** A plan context: shorter, but with a table and an alert, since the plan context renders at the same size. */
export const EDGE_CACHE_CONTEXT = `Product images are served from the app server at full size and resized on every request. Moving them behind the CDN with on-the-fly resizing cuts the product page's largest image from about 1.4 MB to under 200 kB.

| Image | Today | After |
| --- | --- | --- |
| Product hero | 1.4 MB, resized per request | ~180 kB AVIF, cached a year |
| Thumbnails | 120 kB each | ~15 kB each |

> [!NOTE]
> Image URLs gain a content hash, so a replaced image never serves stale from the cache.`;

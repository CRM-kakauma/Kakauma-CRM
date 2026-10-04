/**
 * B4you-like webhook payloads for tests.
 *
 * NOTE: shapes follow the fields the legacy adapter already reads
 * (src/lib/b4you.server.ts) plus the fields named in the CRM spec
 * (charges[].amount, splits.fee, subscription.status, tracking...).
 * Replace/extend with real anonymized payloads as soon as they are available.
 */

type Obj = Record<string, unknown>;

export const CUSTOMER = {
  id: "cus_100",
  full_name: "Maria Souza",
  email: "Maria.Souza@Example.com",
  whatsapp: "(11) 98888-7777",
  document_number: "123.456.789-09",
  address: {
    street: "Rua A",
    number: "10",
    neighborhood: "Centro",
    city: "São Paulo",
    state: "SP",
    zipcode: "01000-000",
  },
};

export function b4(event_name: string, extra: Obj = {}): Obj {
  return {
    event_name,
    created_at: "2026-09-01T10:00:00.000Z",
    updated_at: "2026-09-01T10:00:00.000Z",
    customer: CUSTOMER,
    product: { id: "prod_sleep", name: "Sleep Drink" },
    offer: { id: "off_1", name: "Sleep Drink 1 un", quantity: 1, original_price: 227 },
    ...extra,
  };
}

export const FB_UTMS = {
  utm_source: "facebook",
  utm_medium: "cpc",
  utm_campaign: "camp_x",
  utm_content: "creative_y",
  fbclid: "fb.123",
  src: "funil-1~2f6c1a9e-1111-2222-3333-444455556666",
  custom_param: "kept",
};

/**
 * FICTITIOUS demo data: B4you-like webhooks for local exploration of the CRM
 * when no CRM Supabase project is configured. Names, e-mails and phones are
 * invented. The payloads go through the real pipeline (normalizer + engine),
 * so every number on screen is computed exactly as it would be for real data.
 *
 * Deterministic (seeded PRNG) and relative to `now`, so the data always looks current.
 */

type Obj = Record<string, unknown>;

const FIRST = [
  "Ana",
  "Bruna",
  "Carla",
  "Daniela",
  "Eduarda",
  "Fernanda",
  "Gabriela",
  "Helena",
  "Isabela",
  "Juliana",
  "Larissa",
  "Mariana",
  "Natália",
  "Patrícia",
  "Renata",
  "Sofia",
  "Tatiane",
  "Vanessa",
  "Beatriz",
  "Camila",
  "Bruno",
  "Carlos",
  "Diego",
  "Felipe",
  "Gustavo",
  "Henrique",
  "Igor",
  "João",
  "Lucas",
  "Marcos",
  "Pedro",
  "Rafael",
];
const LAST = [
  "Silva",
  "Santos",
  "Oliveira",
  "Souza",
  "Lima",
  "Pereira",
  "Costa",
  "Rodrigues",
  "Almeida",
  "Nascimento",
  "Ferreira",
  "Araújo",
  "Carvalho",
  "Gomes",
  "Martins",
  "Rocha",
  "Ribeiro",
  "Barbosa",
  "Mendes",
  "Teixeira",
];
const PLACES: [string, string][] = [
  ["São Paulo", "SP"],
  ["Campinas", "SP"],
  ["Rio de Janeiro", "RJ"],
  ["Niterói", "RJ"],
  ["Belo Horizonte", "MG"],
  ["Curitiba", "PR"],
  ["Porto Alegre", "RS"],
  ["Florianópolis", "SC"],
  ["Salvador", "BA"],
  ["Recife", "PE"],
  ["Fortaleza", "CE"],
  ["Goiânia", "GO"],
  ["Brasília", "DF"],
];

/** Campaigns with deliberately different quality profiles. */
const CAMPAIGNS = [
  {
    weight: 30,
    sub: 0.35,
    refund: 0.1,
    rebuy: 0.25,
    utm: {
      utm_source: "facebook",
      utm_medium: "cpc",
      utm_campaign: "sono_profundo_v2",
      utm_content: "video_depoimento",
      src: "funil-quiz~q1",
    },
  },
  {
    weight: 22,
    sub: 0.08,
    refund: 0.22,
    rebuy: 0.08,
    utm: {
      utm_source: "facebook",
      utm_medium: "cpc",
      utm_campaign: "oferta_relampago",
      utm_content: "carrossel_preco",
    },
  },
  {
    weight: 18,
    sub: 0.6,
    refund: 0.04,
    rebuy: 0.2,
    utm: {
      utm_source: "instagram",
      utm_medium: "stories",
      utm_campaign: "influencer_lu",
      utm_content: "story_lu_01",
    },
  },
  {
    weight: 15,
    sub: 0.45,
    refund: 0.05,
    rebuy: 0.35,
    utm: {
      utm_source: "google",
      utm_medium: "search",
      utm_campaign: "marca",
      utm_content: "rsa_marca",
    },
  },
  {
    weight: 10,
    sub: 0.3,
    refund: 0.12,
    rebuy: 0.15,
    utm: {
      utm_source: "afiliado",
      utm_medium: "link",
      utm_campaign: "parceiros",
      utm_content: "link_parceiro",
    },
    affiliate: true,
  },
  { weight: 5, sub: 0.25, refund: 0.08, rebuy: 0.2, utm: null },
];

const ONE_SHOT = [
  {
    product: { id: "prod_sleep", name: "Sleep Drink" },
    offer: { id: "off_1un", name: "Sleep Drink · 1 unidade", quantity: 1, original_price: 197 },
    price: 187,
  },
  {
    product: { id: "prod_sleep", name: "Sleep Drink" },
    offer: { id: "off_3un", name: "Sleep Drink · 3 unidades", quantity: 3, original_price: 497 },
    price: 467,
  },
  {
    product: { id: "prod_sleep", name: "Sleep Drink" },
    offer: { id: "off_6un", name: "Sleep Drink · 6 unidades", quantity: 6, original_price: 897 },
    price: 837,
  },
];
const PLANS = [
  {
    product: { id: "prod_sleep_sub", name: "Sleep Drink Assinatura" },
    offer: { id: "off_sub_m", name: "Assinatura mensal", quantity: 1, original_price: 227 },
    price: 187,
    frequency: "monthly",
    days: 30,
    plan: { id: "plan_m", name: "Mensal" },
  },
  {
    product: { id: "prod_sleep_sub", name: "Sleep Drink Assinatura" },
    offer: { id: "off_sub_t", name: "Assinatura trimestral", quantity: 3, original_price: 597 },
    price: 497,
    frequency: "quarterly",
    days: 90,
    plan: { id: "plan_t", name: "Trimestral" },
  },
];
const AFFILIATES = [
  {
    id: "aff_1",
    email: "parceira.bem.estar@exemplo.com.br",
    full_name: "Parceira Bem-Estar",
    b4f: "B4F001",
  },
  { id: "aff_2", email: "canal.sono@exemplo.com.br", full_name: "Canal do Sono", b4f: "B4F002" },
];

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function slug(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export interface DemoData {
  webhooks: Obj[];
  spend: {
    date: string;
    source: string;
    campaign: string;
    creative: string;
    spend: number;
    clicks: number;
    impressions: number;
  }[];
}

export function buildDemoData(now = new Date(), customers = 140): DemoData {
  const rand = rng(20261005);
  const pick = <T>(a: readonly T[]) => a[Math.floor(rand() * a.length)]!;
  const chance = (p: number) => rand() < p;
  const at = (daysAgo: number, hours = 0) =>
    new Date(now.getTime() - daysAgo * 86_400_000 - hours * 3_600_000).toISOString();
  const weighted = () => {
    const total = CAMPAIGNS.reduce((s, c) => s + c.weight, 0);
    let r = rand() * total;
    for (const c of CAMPAIGNS) if ((r -= c.weight) <= 0) return c;
    return CAMPAIGNS[0]!;
  };

  const out: { at: string; p: Obj }[] = [];
  const push = (p: Obj) =>
    out.push({ at: String(p["paid_at"] ?? p["updated_at"] ?? p["created_at"]), p });
  let seq = 0;
  const id = (prefix: string) => `${prefix}_${(++seq).toString().padStart(5, "0")}`;

  for (let i = 0; i < customers; i++) {
    const first = pick(FIRST);
    const last = pick(LAST);
    const [city, state] = pick(PLACES);
    const customer = {
      id: `demo_cus_${i + 1}`,
      full_name: `${first} ${last}`,
      email: `${slug(first)}.${slug(last)}.${i + 1}@exemplo.com.br`,
      whatsapp: `(${pick(["11", "21", "31", "41", "51", "48", "71", "81", "85", "62", "61"])}) 9${String(8000_0000 + Math.floor(rand() * 9999_9999)).slice(0, 4)}-${String(1000 + Math.floor(rand() * 8999))}`,
      document_number: `${Math.floor(100 + rand() * 899)}.${Math.floor(100 + rand() * 899)}.${Math.floor(100 + rand() * 899)}-${Math.floor(10 + rand() * 89)}`,
      address: {
        street: `Rua ${pick(LAST)}`,
        number: String(Math.floor(10 + rand() * 990)),
        neighborhood: "Centro",
        city,
        state,
        zipcode: `${Math.floor(10000 + rand() * 89999)}-000`,
      },
    };
    const camp = weighted();
    const utm = camp.utm ? { ...camp.utm } : undefined;
    const affiliate = camp.affiliate ? pick(AFFILIATES) : undefined;
    const start = 2 + Math.floor(rand() * 178); // first touch, days ago
    const base: Obj = {
      customer,
      ...(utm ? { tracking_parameters: utm } : {}),
      ...(affiliate ? { affiliate } : {}),
    };

    const kind = rand();
    // --- never bought
    if (kind < 0.1) {
      const o = pick(ONE_SHOT);
      push({
        event_name: "abandoned-cart",
        created_at: at(start),
        updated_at: at(start),
        ...o,
        ...base,
        checkout_url: "https://pay.exemplo.com.br/checkout",
      });
      continue;
    }
    if (kind < 0.15) {
      const o = pick(ONE_SHOT);
      const sale = id("demo_sale");
      push({
        event_name: "generated-pix",
        sale_id: sale,
        status: "pending",
        payment_method: "pix",
        created_at: at(start),
        updated_at: at(start),
        ...o,
        ...base,
        charges: [{ id: id("demo_ch"), amount: o.price }],
        pix: { url: "https://pix.exemplo.com.br/qr", code: "00020126580014BR.GOV.BCB.PIX" },
      });
      if (chance(0.5))
        push({
          event_name: "pix-expired",
          sale_id: sale,
          payment_method: "pix",
          created_at: at(start),
          updated_at: at(Math.max(0, start - 1)),
          ...o,
          customer,
        });
      continue;
    }

    const subscriber = chance(camp.sub);
    if (!subscriber) {
      // --- one-shot buyer
      const o = pick(ONE_SHOT);
      if (chance(0.35))
        push({
          event_name: "abandoned-cart",
          created_at: at(start, 3),
          updated_at: at(start, 3),
          ...o,
          ...base,
        });
      const method = pick(["pix", "pix", "card", "card", "billet"] as const);
      const sale = id("demo_sale");
      const charge = id("demo_ch");
      if (method === "pix")
        push({
          event_name: "generated-pix",
          sale_id: sale,
          status: "pending",
          payment_method: "pix",
          created_at: at(start, 1),
          updated_at: at(start, 1),
          ...o,
          ...base,
          charges: [{ id: charge, amount: o.price }],
        });
      if (method === "billet")
        push({
          event_name: "generated-billet",
          sale_id: sale,
          status: "pending",
          payment_method: "billet",
          created_at: at(start + 2),
          updated_at: at(start + 2),
          ...o,
          ...base,
          charges: [{ id: charge, amount: o.price }],
        });
      const fee = Math.round(o.price * 0.0699 * 100) / 100;
      const aff = affiliate ? Math.round(o.price * 0.3 * 100) / 100 : 0;
      push({
        event_name: "approved-payment",
        sale_id: sale,
        status: "paid",
        payment_method: method,
        installments: method === "card" ? pick([1, 3, 6, 12]) : 1,
        ...(method === "card"
          ? {
              card: [
                {
                  brand: pick(["visa", "mastercard", "elo"]),
                  last_four: String(1000 + Math.floor(rand() * 8999)),
                },
              ],
            }
          : {}),
        created_at: at(start, 1),
        updated_at: at(start),
        paid_at: at(start),
        ...o,
        ...base,
        charges: [{ id: charge, amount: o.price }],
        splits: {
          fee,
          my_commission: Math.round((o.price - fee - aff) * 100) / 100,
          affiliate_commission: aff || undefined,
          released: start > 30,
          release_date: at(start - 30),
        },
        ...(chance(0.15) ? { coupon: { code: "SONO10", type: "percent", amount: 10 } } : {}),
      });
      // logistics
      const tracking = `LG${String(100000 + seq)}BR`;
      if (start >= 1)
        push({
          event_name: "tracking",
          sale_id: sale,
          created_at: at(start - 1),
          updated_at: at(Math.max(0, start - 1)),
          customer,
          tracking: {
            code: tracking,
            company: "Loggi",
            url: `https://www.loggi.com/rastreador/${tracking}`,
            status: "posted",
          },
          shipping: { cost: pick([19.9, 24.9, 29.9]) },
        });
      const outcome = rand();
      const delivery = 3 + Math.floor(rand() * 6);
      if (start > delivery) {
        const status =
          outcome < 0.86
            ? "delivered"
            : outcome < 0.94
              ? "delayed"
              : outcome < 0.97
                ? "returned"
                : "lost";
        push({
          event_name: "tracking",
          sale_id: sale,
          created_at: at(start - delivery),
          updated_at: at(start - delivery),
          customer,
          tracking: {
            code: tracking,
            company: "Loggi",
            status,
            ...(status === "delivered" ? { delivered_at: at(start - delivery) } : {}),
          },
        });
      } else if (start > 2) {
        push({
          event_name: "tracking",
          sale_id: sale,
          created_at: at(start - 2),
          updated_at: at(start - 2),
          customer,
          tracking: { code: tracking, company: "Loggi", status: "in transit" },
        });
      }
      if (chance(camp.refund) && start > 8) {
        const partial = chance(0.3);
        push({
          event_name: "refund",
          sale_id: sale,
          updated_at: at(start - 7),
          customer,
          charges: [{ id: charge, amount: o.price }],
          refund: {
            amount: partial ? Math.round(o.price * 0.4) : o.price,
            reason: pick([
              "não gostou do sabor",
              "produto chegou danificado",
              "desistência",
              "compra duplicada",
            ]),
          },
        });
      }
      // rebuys
      let d = start;
      while (chance(camp.rebuy) && d > 35) {
        d -= 25 + Math.floor(rand() * 30);
        if (d < 1) break; // never in the future
        const o2 = pick(ONE_SHOT);
        const s2 = id("demo_sale");
        push({
          event_name: "approved-payment",
          sale_id: s2,
          status: "paid",
          payment_method: pick(["pix", "card"]),
          created_at: at(d),
          updated_at: at(d),
          paid_at: at(d),
          ...o2,
          customer,
          charges: [{ id: id("demo_ch"), amount: o2.price }],
          splits: { fee: Math.round(o2.price * 0.0699 * 100) / 100 },
        });
        if (d > 6)
          push({
            event_name: "tracking",
            sale_id: s2,
            created_at: at(d - 5),
            updated_at: at(d - 5),
            customer,
            tracking: {
              code: `LG${String(100000 + seq)}BR`,
              company: "Loggi",
              status: "delivered",
              delivered_at: at(d - 5),
            },
            shipping: { cost: 24.9 },
          });
      }
      continue;
    }

    // --- subscriber
    const plan = pick(PLANS);
    const subId = `demo_sub_${i + 1}`;
    const sub = (status: string, extra: Obj = {}) => ({
      id: subId,
      status,
      frequency: plan.frequency,
      plan: plan.plan,
      ...extra,
    });
    const maxCycles = Math.floor(start / plan.days) + 1;
    const fate = rand(); // how this subscription evolves
    const cycles = fate < 0.55 ? maxCycles : Math.max(1, Math.floor(rand() * maxCycles) + 1);
    let lastPaid = start;
    for (let c = 0; c < cycles; c++) {
      const d = start - c * plan.days;
      if (d < 0) break;
      // some renewals were late first, then recovered
      // some asked to cancel and were retained (renewed anyway)
      if (c > 0 && chance(0.1)) {
        push({
          event_name: "canceled-subscription",
          updated_at: at(d + 5),
          customer,
          subscription: sub("active"),
        });
      }
      if (c > 0 && chance(0.12) && d > 3) {
        push({
          event_name: "late-subscription",
          updated_at: at(d + 2),
          customer,
          subscription: sub("active"),
        });
      }
      const sale = id("demo_sale");
      push({
        event_name: c === 0 ? "approved-payment" : "renewed-subscription",
        sale_id: sale,
        status: "paid",
        payment_method: "card",
        card: [
          {
            brand: pick(["visa", "mastercard"]),
            last_four: String(1000 + Math.floor(rand() * 8999)),
          },
        ],
        created_at: at(d),
        updated_at: at(d),
        paid_at: at(d),
        ...plan,
        customer,
        ...(c === 0 ? base : {}),
        charges: [{ id: id("demo_ch"), amount: plan.price }],
        splits: { fee: Math.round(plan.price * 0.0599 * 100) / 100 },
        subscription: sub("active", { next_charge: at(d - plan.days) }),
      });
      if (d > 5)
        push({
          event_name: "tracking",
          sale_id: sale,
          created_at: at(d - 4),
          updated_at: at(d - 4),
          customer,
          tracking: {
            code: `LG${String(100000 + seq)}BR`,
            company: pick(["Loggi", "Correios"]),
            status: "delivered",
            delivered_at: at(d - 4),
          },
          shipping: { cost: 0 },
        });
      lastPaid = d;
    }
    const nextDue = lastPaid - plan.days; // negative = in the future
    if (cycles < maxCycles && nextDue >= 0) {
      // did not renew: late → cancelled, or asked to cancel → cancelled
      const late = nextDue + 1;
      push({
        event_name: "late-subscription",
        updated_at: at(late),
        customer,
        subscription: sub("active"),
      });
      if (chance(0.5))
        push({
          event_name: "canceled-subscription",
          updated_at: at(Math.max(0, late - 2)),
          customer,
          subscription: sub("active"),
        });
      if (late > 10)
        push({
          event_name: "canceled-subscription",
          updated_at: at(late - 10),
          customer,
          subscription: sub("canceled"),
        });
    } else if (nextDue < 0 && nextDue > -7) {
      push({
        event_name: "subscription.expiring_soon",
        updated_at: at(0, 12),
        customer,
        subscription: sub("active", { next_charge: at(nextDue) }),
      });
    } else if (chance(0.08)) {
      push({
        event_name: "canceled-subscription",
        updated_at: at(Math.max(0, Math.floor(lastPaid / 3))),
        customer,
        subscription: sub("active"),
      });
    }
  }

  // --- a few very recent events: recovery queue and automations have something to act on now
  const recent: [string, number, Obj][] = [
    ["abandoned-cart", 2, { ...ONE_SHOT[1]!, tracking_parameters: CAMPAIGNS[0]!.utm }],
    ["abandoned-cart", 5, { ...ONE_SHOT[0]!, tracking_parameters: CAMPAIGNS[2]!.utm }],
    [
      "generated-pix",
      1,
      {
        ...ONE_SHOT[0]!,
        sale_id: "demo_sale_recent_pix",
        payment_method: "pix",
        charges: [{ id: "demo_ch_recent_pix", amount: 187 }],
      },
    ],
    [
      "approved-payment",
      3,
      {
        ...ONE_SHOT[2]!,
        sale_id: "demo_sale_recent_buy",
        payment_method: "card",
        charges: [{ id: "demo_ch_recent_buy", amount: 837 }],
        tracking_parameters: CAMPAIGNS[3]!.utm,
      },
    ],
  ];
  recent.forEach(([ev, hours, extra], k) => {
    const first = pick(FIRST);
    const last = pick(LAST);
    const ts = at(0, hours);
    push({
      event_name: ev,
      created_at: ts,
      updated_at: ts,
      ...(ev === "approved-payment" ? { paid_at: ts, status: "paid" } : {}),
      customer: {
        id: `demo_cus_recent_${k}`,
        full_name: `${first} ${last}`,
        email: `${slug(first)}.${slug(last)}.r${k}@exemplo.com.br`,
        whatsapp: `(11) 9${8100 + k}-${2000 + k}`,
        address: { city: "São Paulo", state: "SP" },
      },
      ...extra,
    });
  });

  out.sort((a, b) => a.at.localeCompare(b.at));

  // --- ad spend per campaign/day (makes CAC and LTV/CAC visible)
  const spend: DemoData["spend"] = [];
  const DAILY: Record<string, number> = {
    sono_profundo_v2: 55,
    oferta_relampago: 45,
    influencer_lu: 22,
    marca: 9,
  };
  for (let d = 180; d >= 1; d--) {
    const date = at(d).slice(0, 10);
    for (const c of CAMPAIGNS) {
      if (!c.utm || !(c.utm.utm_campaign in DAILY)) continue;
      const v = DAILY[c.utm.utm_campaign]! * (0.7 + rand() * 0.6);
      spend.push({
        date,
        source: c.utm.utm_source,
        campaign: c.utm.utm_campaign,
        creative: c.utm.utm_content,
        spend: Math.round(v * 100) / 100,
        clicks: Math.round(v * (2 + rand() * 2)),
        impressions: Math.round(v * (60 + rand() * 40)),
      });
    }
  }

  return { webhooks: out.map((x) => x.p), spend };
}

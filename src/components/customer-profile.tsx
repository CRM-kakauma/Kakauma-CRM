import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { fetchCustomerProfile } from "@/services/analytics";

type Obj = Record<string, unknown>;
const s = (v: unknown) => (v == null || v === "" ? null : String(v));

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="label-eyebrow">{label}</dt>
      <dd className="mt-1 break-words text-sm">{value ?? "—"}</dd>
    </div>
  );
}

export function CustomerProfile({ userId, onOpenTx }: { userId: string; onOpenTx: (id: string) => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["customer-profile", userId],
    queryFn: () => fetchCustomerProfile(userId),
  });
  if (isLoading) return <Skeleton className="mt-4 h-48 w-full" />;
  if (!data) return null;
  const m = (data.latest ?? {}) as Obj;
  const addr = (m["address"] ?? {}) as Obj;
  const utm = (m["utm"] ?? {}) as Obj;
  const first = (data.first_touch ?? {}) as Obj;
  const coupon = m["coupon"] as Obj | null;
  const aff = m["affiliate"] as Obj | null;
  const street = [s(addr["street"]), s(addr["number"]), s(addr["complement"])].filter(Boolean).join(", ");
  const cityLine = [s(addr["neighborhood"]), s(addr["city"] ?? m["city"]), s(addr["state"] ?? m["state"]), s(addr["zipcode"] ?? addr["zip_code"])]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <div className="surface p-5">
        <h3 className="mb-4 text-sm font-semibold">Contato e endereço</h3>
        <dl className="grid grid-cols-2 gap-4">
          <Field label="WhatsApp" value={s(m["whatsapp"])} />
          <Field label="CPF/CNPJ" value={s(m["document"])} />
          <div className="col-span-2"><Field label="Endereço" value={street || null} /></div>
          <div className="col-span-2"><Field label="Cidade / Estado / CEP" value={cityLine || null} /></div>
        </dl>
      </div>
      <div className="surface p-5">
        <h3 className="mb-4 text-sm font-semibold">Origem e compra</h3>
        <dl className="grid grid-cols-2 gap-4">
          <Field label="UTM Source (última)" value={s(utm["source"])} />
          <Field label="UTM Campaign (última)" value={s(utm["campaign"])} />
          <Field label="UTM Medium" value={s(utm["medium"])} />
          <Field label="UTM Content" value={s(utm["content"])} />
          <Field label="Primeiro contato" value={[s(first["source"]), s(first["campaign"])].filter(Boolean).join(" · ") || null} />
          <Field label="UTM Term" value={s(utm["term"])} />
          <div className="col-span-2"><Field label="Ofertas compradas" value={data.offers.join(", ") || null} /></div>
          <Field label="Parcelas" value={s(m["installments"]) ? `${s(m["installments"])}x` : null} />
          <Field label="Cupom" value={coupon ? s(coupon["name"]) : null} />
          <div className="col-span-2"><Field label="Afiliado" value={aff ? [s(aff["name"]), s(aff["email"])].filter(Boolean).join(" · ") || null : null} /></div>
        </dl>
      </div>
      {data.transactions.length > 0 && (
        <div className="surface overflow-x-auto p-5 lg:col-span-2">
          <h3 className="mb-3 text-sm font-semibold">Transações</h3>
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 font-medium">Data</th>
                <th className="py-2 font-medium">Transação</th>
                <th className="py-2 font-medium">Método</th>
                <th className="py-2 font-medium">Status</th>
                <th className="py-2 text-right font-medium">Valor</th>
                <th className="py-2 text-right font-medium">Líquido</th>
              </tr>
            </thead>
            <tbody>
              {data.transactions.map((t) => (
                <tr key={t.id} onClick={() => onOpenTx(t.id)} className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-primary-soft">
                  <td className="py-2 num">{formatDateTime(t.created_at)}</td>
                  <td className="py-2 font-mono text-xs">{t.external_transaction_id.slice(0, 13)}…</td>
                  <td className="py-2 uppercase">{t.payment_method ?? "—"}</td>
                  <td className="py-2">{t.status}</td>
                  <td className="py-2 text-right num">{formatCurrency(t.value)}</td>
                  <td className="py-2 text-right num">{t.net_value != null ? formatCurrency(t.net_value) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

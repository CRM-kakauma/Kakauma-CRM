import { useQuery, type UseQueryOptions } from "@tanstack/react-query";

/**
 * Browser side of the CRM API. Every call goes through /api/crm/rpc, which
 * checks the session cookie and the user's role on the server.
 */

export class CrmApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export async function crmCall<T = unknown>(
  fn: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch("/api/crm/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ fn, args }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    data?: T;
    error?: string;
    message?: string;
  };
  if (!res.ok) throw new CrmApiError(res.status, body.error ?? "error", body.message ?? body.error);
  return body.data as T;
}

export function useCrm<T = unknown>(
  fn: string,
  args: Record<string, unknown> = {},
  opts: Omit<UseQueryOptions<T, CrmApiError>, "queryKey" | "queryFn"> = {},
) {
  return useQuery<T, CrmApiError>({
    queryKey: ["crm", fn, args],
    queryFn: () => crmCall<T>(fn, args),
    retry: (count, err) => err.status >= 500 && count < 2,
    ...opts,
  });
}

export interface Me {
  email: string;
  role: "admin" | "operator" | "viewer";
  /** false when running locally without login */
  login?: boolean;
  /** true when running on the in-memory database with fictitious data */
  demo?: boolean;
  demo_state?: "loading" | "ready" | "error";
}

export function useMe() {
  return useQuery<Me | null, CrmApiError>({
    queryKey: ["crm-me"],
    queryFn: async () => {
      const res = await fetch("/api/crm/auth/me", { credentials: "same-origin" });
      if (res.status === 401) return null;
      const body = (await res.json().catch(() => ({}))) as Me & {
        error?: string;
        message?: string;
      };
      if (!res.ok) throw new CrmApiError(res.status, body.error ?? "error", body.message);
      return body;
    },
    staleTime: 60_000,
    retry: false,
    // While the demo database is being built, poll so the screens know when it is ready.
    refetchInterval: (q) => (q.state.data?.demo_state === "loading" ? 2000 : false),
  });
}

// ------------------------------------------------------------------ labels (pt-BR)

export const LIFECYCLE_LABEL: Record<string, string> = {
  LEAD: "Lead",
  PROSPECT: "Prospect",
  CHECKOUT_STARTED: "Checkout iniciado",
  PURCHASED: "Comprou",
  DELIVERING: "Em entrega",
  DELIVERED: "Entregue",
  ACTIVE_CUSTOMER: "Cliente ativo",
  REPEAT_CUSTOMER: "Recompra",
  CHURNED: "Perdido",
  NEW_SUBSCRIBER: "Novo assinante",
  ACTIVE_SUBSCRIBER: "Assinante ativo",
  EXPIRING: "Expirando",
  RENEWED: "Renovou",
  LATE: "Atrasado",
  RECOVERED: "Recuperado",
  CANCELLATION_REQUESTED: "Pediu cancelamento",
  CANCELLED: "Cancelado",
  REACTIVATED: "Reativado",
};

export const RISK_LABEL: Record<string, string> = {
  HEALTHY: "Saudável",
  AT_RISK: "Em risco",
  PAYMENT_RISK: "Risco de pagamento",
  CHURN_RISK: "Risco de churn",
  HIGH_VALUE_AT_RISK: "Alto valor em risco",
};

export const TYPE_LABEL: Record<string, string> = {
  LEAD: "Lead",
  PROSPECT: "Prospect",
  ONE_TIME_CUSTOMER: "Compra avulsa",
  SUBSCRIBER: "Assinante",
  HYBRID_CUSTOMER: "Híbrido",
  FORMER_SUBSCRIBER: "Ex-assinante",
  CHURNED_CUSTOMER: "Cliente perdido",
  REACTIVATED_CUSTOMER: "Reativado",
};

export const FACT_LABEL: Record<string, string> = {
  CHECKOUT_ABANDONED: "Abandonou checkout",
  PAYMENT_PENDING: "Pagamento pendente",
  PURCHASE_PAID: "Compra aprovada",
  RENEWAL_PAID: "Renovação paga",
  PAYMENT_FAILED: "Pagamento recusado",
  REFUND_ISSUED: "Reembolso",
  CHARGEBACK_RECEIVED: "Chargeback",
  SUBSCRIPTION_CREATED: "Assinatura criada",
  SUBSCRIPTION_RENEWED: "Assinatura renovada",
  SUBSCRIPTION_PAYMENT_LATE: "Pagamento atrasado",
  SUBSCRIPTION_PAYMENT_RECOVERED: "Pagamento recuperado",
  SUBSCRIPTION_CANCELLATION_REQUESTED: "Pediu cancelamento",
  SUBSCRIPTION_CANCELLED: "Assinatura cancelada",
  SUBSCRIPTION_EXPIRED: "Assinatura expirada",
  SUBSCRIPTION_REACTIVATED: "Assinatura reativada",
  SUBSCRIPTION_SAVED: "Retido (desistiu de cancelar)",
  SUBSCRIPTION_EXPIRING_SOON: "Assinatura expirando",
  LIFECYCLE_CHANGED: "Mudou de etapa",
  RISK_CHANGED: "Mudou de risco",
  SEGMENT_ENTERED: "Entrou em segmento",
  SEGMENT_EXITED: "Saiu de segmento",
  FULFILLMENT_FULFILLMENT_CREATED: "Envio criado",
  FULFILLMENT_SHIPPED: "Enviado",
  FULFILLMENT_IN_TRANSIT: "Em trânsito",
  FULFILLMENT_OUT_FOR_DELIVERY: "Saiu para entrega",
  FULFILLMENT_DELIVERED: "Entregue",
  FULFILLMENT_DELIVERY_DELAYED: "Entrega atrasada",
  FULFILLMENT_DELIVERY_FAILED: "Falha na entrega",
  FULFILLMENT_DELIVERY_RETURNED: "Devolvido",
  FULFILLMENT_DELIVERY_LOST: "Extraviado",
};

export const RUN_STATUS_LABEL: Record<string, string> = {
  QUEUED: "Agendada",
  PROCESSING: "Processando",
  SENT: "Enviada",
  DRY_RUN: "Simulação",
  SKIPPED: "Pulada",
  FAILED: "Falhou",
  CANCELLED: "Cancelada",
};

export const SKIP_LABEL: Record<string, string> = {
  conditions_not_met: "condições não atendidas no momento do envio",
  cooldown: "intervalo mínimo entre envios",
  daily_cap: "limite diário do cliente",
  automation_inactive: "automação desligada",
};

export const label = (map: Record<string, string>, key: string | null | undefined) =>
  key ? (map[key] ?? key) : "—";

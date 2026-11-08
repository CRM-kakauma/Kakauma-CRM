/** WhatsApp inbox: calls to /api/crm/wa/* and their react-query hooks. */
import { useQuery } from "@tanstack/react-query";

export interface WaInstance {
  name: string;
  label: string;
  color: string;
  number: string | null;
  profile_name: string | null;
  state: string | null;
  unread: number;
  chats: number;
  flows?: boolean;
  error?: string;
}

export interface WaChat {
  chat_id: string;
  instance: string;
  remote_jid: string;
  phone: string | null;
  name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  last_message_at: string | null;
  last_preview: string | null;
  last_from_me: boolean | null;
  last_status: string | null;
  unread: number;
  archived: boolean;
  tier?: Tier;
}

export type Tier = "sem_compra" | "bronze" | "prata" | "ouro";

export interface WaBadges {
  tier: Tier;
  tier_label: string;
  tip: string | null;
  orders: number;
  revenue: number;
  days_since_purchase: number | null;
  auto: {
    key: string;
    label: string;
    tone: "warning" | "info" | "success" | "danger";
    hint: string;
  }[];
  manual: string[];
}

export interface TiersConfig {
  sem_compra: { label: string; tip: string };
  bronze: { label: string; tip: string };
  prata: { label: string; orders: number; revenue: number; tip: string };
  ouro: { label: string; orders: number; revenue: number; tip: string };
  repurchase_days: number;
  inactive_days: number;
}

export const useWaTags = () =>
  useQuery({
    queryKey: ["wa", "tags"],
    queryFn: () =>
      waFetch<{ tags: string[]; tiers: TiersConfig | null; can_edit_tiers: boolean }>("tags"),
    staleTime: 60_000,
  });

export interface WaChatDetail extends WaChat {
  badges?: WaBadges;
  customer_email: string | null;
  lifecycle_stage: string | null;
  customer_type: string | null;
  total_net_revenue: number | null;
  total_paid_orders: number | null;
  last_purchase_at: string | null;
  instance_label: string | null;
  instance_color: string | null;
}

export interface WaMessage {
  id: number;
  wa_id: string;
  from_me: boolean;
  type: string;
  body: string | null;
  media: {
    mimetype?: string | null;
    file_name?: string;
    seconds?: number;
    ptt?: boolean;
    quoted?: string;
    lat?: number;
    lng?: number;
    phone?: string;
    size?: number | null;
  } | null;
  status: string | null;
  sent_by: string | null;
  at: string;
}

export class WaError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function waFetch<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/crm/wa/${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok)
    throw new WaError(String(data["message"] ?? data["error"] ?? `Erro ${res.status}`), res.status);
  return data as T;
}

export const useWaInstances = () =>
  useQuery({
    queryKey: ["wa", "instances"],
    queryFn: () =>
      waFetch<{ instances: WaInstance[]; can_manage: boolean; can_delete: boolean }>("instances"),
    refetchInterval: 30_000,
    retry: false,
  });

export const useWaChats = (instance: string | null, q: string, filter: string) =>
  useQuery({
    queryKey: ["wa", "chats", instance, q, filter],
    queryFn: () =>
      waFetch<{ chats: WaChat[] }>(
        `chats?${new URLSearchParams({ instance: instance ?? "", q, filter })}`,
      ),
    enabled: !!instance,
    refetchInterval: 4_000,
    placeholderData: (prev) => prev,
  });

export const useWaMessages = (chat: string | null) =>
  useQuery({
    queryKey: ["wa", "messages", chat],
    queryFn: () =>
      waFetch<{ chat: WaChatDetail | null; messages: WaMessage[] }>(
        `messages?${new URLSearchParams({ chat: chat ?? "" })}`,
      ),
    enabled: !!chat,
    refetchInterval: 3_000,
  });

export const mediaUrl = (chat: string, waId: string) =>
  `/api/crm/wa/media?${new URLSearchParams({ chat, id: waId })}`;

/** File → base64 (without the data: prefix). */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error ?? new Error("Não foi possível ler o arquivo"));
    r.readAsDataURL(file);
  });
}

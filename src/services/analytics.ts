import { supabase } from "@/integrations/supabase/client";
import type { EventType } from "@/lib/events";

/**
 * Single data-access layer for every analytics read.
 * All aggregation happens in the database (analytics_* functions);
 * the UI never computes metrics from raw event lists.
 */

export type Bucket = "day" | "week" | "month";

export interface MetricsBlock {
  revenue: number;
  net_revenue: number;
  affiliate_cost: number;
  approved_purchases: number;
  refunds: number;
  chargebacks: number;
  failed_payments: number;
  funnel_users: number;
  converted_users: number;
  conversion_rate: number;
  refund_rate: number;
  chargeback_rate: number;
  unique_users: number;
  transactions_count: number;
  payment_attempts: number;
  events_count: number;
}

export interface OverviewResult {
  current: MetricsBlock;
  previous: MetricsBlock;
  from: string;
  to: string;
}

export interface FunnelStage {
  key: string;
  label: string;
  users: number;
  conversion: number;
  drop_off: number;
  drop_off_users: number;
}

export interface FunnelResult {
  stages: FunnelStage[];
  methods: {
    pix: { generated: number; approved: number; conversion: number };
    boleto: { generated: number; approved: number; conversion: number };
  };
  payment_attempts: number;
}

export interface TimeseriesPoint {
  bucket: string;
  revenue: number;
  net_revenue: number;
  approved_purchases: number;
  users: number;
  transactions_count: number;
}

export interface UserHit {
  id: string;
  external_user_id: string;
  name: string | null;
  email: string | null;
  last_seen_at: string | null;
}

export interface JourneyEvent {
  id: string;
  event_type: EventType;
  timestamp: string;
  value: number | null;
  source: string | null;
  transaction_id: string | null;
  external_transaction_id: string | null;
}

export interface CustomerResult {
  user: UserHit & { created_at: string; first_seen_at: string | null };
  metrics: { total_spent: number; transactions: number; refunds: number; chargebacks: number };
  journey: JourneyEvent[];
}

export interface TransactionDetailResult {
  transaction: {
    id: string;
    external_transaction_id: string;
    value: number;
    net_value: number | null;
    affiliate_value: number | null;
    currency: string;
    status: string;
    payment_method: string | null;
    product_id: string | null;
    created_at: string;
    approved_at: string | null;
  } | null;
  user: { id: string; name: string | null; email: string | null; external_user_id: string } | null;
  timeline: { id: string; event_type: EventType; timestamp: string; value: number | null }[];
  payment_attempts: number;
  time_to_conversion_minutes: number | null;
}

export interface EventRow {
  id: string;
  event_id: string;
  event_type: EventType;
  timestamp: string;
  value: number | null;
  source: string | null;
  product_id?: string | null;
  currency?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
  users: { name: string | null; email: string | null; external_user_id: string } | null;
  transactions: { external_transaction_id: string } | null;
}

function iso(d: Date) {
  return d.toISOString();
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name as never, args as never);
  if (error) throw new Error(error.message);
  return data as unknown as T;
}

export function fetchOverview(from: Date, to: Date) {
  return rpc<OverviewResult>("analytics_overview", { p_from: iso(from), p_to: iso(to) });
}

export function fetchFunnel(from: Date, to: Date) {
  return rpc<FunnelResult>("analytics_funnel", { p_from: iso(from), p_to: iso(to) });
}

export function fetchTimeseries(from: Date, to: Date, bucket: Bucket) {
  return rpc<TimeseriesPoint[]>("analytics_timeseries", {
    p_from: iso(from),
    p_to: iso(to),
    p_bucket: bucket,
  });
}

export function searchUsers(query: string) {
  return rpc<UserHit[]>("search_users", { p_query: query, p_limit: 12 });
}

export function fetchCustomer(userId: string) {
  return rpc<CustomerResult>("customer_summary", { p_user_id: userId });
}

export function fetchTransactionDetail(transactionId: string) {
  return rpc<TransactionDetailResult>("transaction_detail", { p_transaction_id: transactionId });
}

export async function fetchRecentUsers(limit = 8): Promise<UserHit[]> {
  const { data, error } = await supabase
    .from("users")
    .select("id, external_user_id, name, email, last_seen_at")
    .order("last_seen_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data as UserHit[];
}

export async function fetchEvents(filters: {
  eventType?: EventType | "ALL";
  userId?: string | null;
  from?: Date;
  to?: Date;
  limit?: number;
}): Promise<EventRow[]> {
  let q = supabase
    .from("events")
    .select(
      "id, event_id, event_type, timestamp, value, source, product_id, currency, metadata, created_at, users(name, email, external_user_id), transactions(external_transaction_id)",
    )
    .order("timestamp", { ascending: false })
    .limit(filters.limit ?? 100);

  if (filters.eventType && filters.eventType !== "ALL") q = q.eq("event_type", filters.eventType);
  if (filters.userId) q = q.eq("user_id", filters.userId);
  if (filters.from) q = q.gte("timestamp", iso(filters.from));
  if (filters.to) q = q.lt("timestamp", iso(filters.to));

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data as unknown as EventRow[];
}

export interface BreakdownRow {
  key: string;
  sales: number;
  revenue: number;
  net_revenue: number;
  affiliate_cost: number;
  units: number;
}
export interface BreakdownResult {
  sources: BreakdownRow[];
  campaigns: BreakdownRow[];
  offers: BreakdownRow[];
}
export function fetchBreakdown(from: Date, to: Date) {
  return rpc<BreakdownResult>("analytics_breakdown", { p_from: iso(from), p_to: iso(to) });
}

export interface CustomerProfile {
  latest: Record<string, unknown> | null;
  first_touch: Record<string, string | null> | null;
  offers: string[];
  transactions: {
    id: string;
    external_transaction_id: string;
    value: number;
    net_value: number | null;
    affiliate_value: number | null;
    status: string;
    payment_method: string | null;
    created_at: string;
  }[];
}
export function fetchCustomerProfile(userId: string) {
  return rpc<CustomerProfile>("customer_profile", { p_user_id: userId });
}

-- =====================================================================
-- KAKAUMA CRM — Pushfy webhook: a whole batch in one call
--
--   Pushfy sends delivery reports in batches (after an outage, thousands at
--   once, ~1 MB). Saved one call per report, a batch took longer than Pushfy
--   waits (30 s): the request was cut, retried, and never finished. Now the
--   server sends the batch in a few calls and the database loops over it.
-- =====================================================================

create or replace function public.crm_pushfy_events(p_payloads jsonb) returns jsonb
language plpgsql security definer set search_path = crm, public, extensions as $$
declare
  e jsonb;
  r jsonb;
  n int := 0;
  matched int := 0;
  duplicates int := 0;
  optouts int := 0;
begin
  if jsonb_typeof(p_payloads) <> 'array' then raise exception 'payloads must be an array'; end if;
  for e in select x from jsonb_array_elements(p_payloads) x loop
    continue when jsonb_typeof(e) <> 'object';
    r := public.crm_pushfy_event(e);
    n := n + 1;
    if coalesce((r ->> 'message_matched')::boolean, false) then matched := matched + 1; end if;
    if coalesce((r ->> 'duplicate')::boolean, false) then duplicates := duplicates + 1; end if;
    optouts := optouts + coalesce((r ->> 'optout')::int, 0);
  end loop;
  return jsonb_build_object('ok', true, 'received', n, 'matched', matched, 'duplicates', duplicates,
                            'optouts', optouts);
end;
$$;

revoke all on function public.crm_pushfy_events(jsonb) from public, anon, authenticated;
grant execute on function public.crm_pushfy_events(jsonb) to service_role;

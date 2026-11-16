-- =====================================================================
-- KAKAUMA CRM — putting a customer in a flow by hand (customer page)
--
--   A real enrollment, like one started by an event: the flow's waits, the
--   entry rule, the send window, the daily limit and the channels' LIVE
--   switches all apply, and it counts in the flow's numbers. Not a test.
--   Refused when the person is already in the flow; a flow set to "only
--   once" asks for confirmation (p_force) when the person went through it.
-- =====================================================================

create or replace function public.crm_enroll_customer(p_flow_key text, p_customer uuid,
                                                      p_force boolean default false, p_actor text default null)
returns jsonb
language plpgsql security definer set search_path = crm, public, extensions as $$
declare
  f crm.flows;
  v_trigger text;
  v_id uuid;
begin
  perform crm.set_actor(p_actor);
  select * into f from crm.flows where key = p_flow_key;
  if not found then raise exception 'Fluxo não encontrado'; end if;
  if f.status <> 'ACTIVE' or coalesce(f.version, 0) <= 0 then
    raise exception 'O fluxo "%" não está ativo: publique e ative antes', f.name;
  end if;
  if not exists (select 1 from crm.customers where customer_id = p_customer) then
    raise exception 'Cliente não encontrado';
  end if;
  if exists (select 1 from crm.flow_enrollments where flow_id = f.flow_id and customer_id = p_customer
              and status in ('ACTIVE','WAITING') and not is_test) then
    raise exception 'Este cliente já está no fluxo "%"', f.name;
  end if;
  if f.reentry = 'once' and not coalesce(p_force, false)
     and exists (select 1 from crm.flow_enrollments where flow_id = f.flow_id and customer_id = p_customer and not is_test) then
    raise exception 'ONCE: este cliente já passou pelo fluxo "%" (configurado para uma vez só)', f.name;
  end if;
  -- a test of the same flow running for this person gives way
  update crm.flow_enrollments set status = 'EXITED', exit_reason = 'manual_enroll', finished_at = now(),
         next_run_at = null, updated_at = now()
   where flow_id = f.flow_id and customer_id = p_customer and is_test and status in ('ACTIVE','WAITING');

  v_trigger := (select n ->> 'id' from crm.flow_versions v, jsonb_array_elements(v.graph -> 'nodes') n
                 where v.flow_id = f.flow_id and v.version = f.version and n ->> 'type' = 'trigger' limit 1);
  insert into crm.flow_enrollments (flow_id, version, customer_id, current_node, next_run_at)
  values (f.flow_id, f.version, p_customer, v_trigger, now())
  returning enrollment_id into v_id;

  insert into crm.audit_logs (entity, entity_id, field, old_value, new_value, actor)
  values ('flows', p_flow_key, 'manual_enroll', null, p_customer::text, crm.current_actor());
  return jsonb_build_object('enrollment_id', v_id, 'flow', f.name);
end;
$$;
revoke all on function public.crm_enroll_customer(text, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.crm_enroll_customer(text, uuid, boolean, text) to service_role;

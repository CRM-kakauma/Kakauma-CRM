-- =====================================================================
-- KAKAUMA CRM — access level "x1" (attendance)
--   Only the Clientes and Recuperação screens, read-only. The app server
--   enforces it (gateway allow-list); here the role becomes valid.
-- =====================================================================

alter table crm.app_users drop constraint app_users_role_check;
alter table crm.app_users add constraint app_users_role_check
  check (role in ('admin','operator','viewer','x1'));

create or replace function public.crm_set_user_access(p_email text, p_role text, p_active boolean, p_actor text default null)
returns void language plpgsql security definer set search_path = crm, public, extensions as $$
begin
  perform crm.set_actor(p_actor);
  if p_role not in ('admin','operator','viewer','x1') then raise exception 'invalid role'; end if;
  if (p_role <> 'admin' or not p_active)
     and exists (select 1 from crm.app_users where lower(email) = lower(p_email) and role = 'admin' and active)
     and (select count(*) from crm.app_users where role = 'admin' and active) <= 1 then
    raise exception 'the last active admin cannot be demoted or deactivated';
  end if;
  update crm.app_users set role = p_role, active = p_active where lower(email) = lower(p_email);
  if not found then raise exception 'user % not found', p_email; end if;
end;
$$;

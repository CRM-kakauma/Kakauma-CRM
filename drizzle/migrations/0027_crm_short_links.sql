-- =====================================================================
-- KAKAUMA CRM — link shortener for SMS/RCS
--
--   /l/<code> on the CRM's address sends the visitor to the stored store
--   link (with its UTMs) and counts the click. Only kakauma.com.br links can
--   be shortened, so the CRM's address is never a redirect to other sites.
--   The same long link always gets the same code.
-- =====================================================================

create table crm.short_links (
  code text primary key check (code ~ '^[A-Za-z0-9]{4,12}$'),
  url text not null unique
    check (url ~* '^https://([a-z0-9-]+\.)*kakauma\.com\.br(/|\?|#|$)' and length(url) <= 2000),
  created_by text,
  created_at timestamptz not null default now(),
  clicks bigint not null default 0,
  last_click_at timestamptz
);
alter table crm.short_links enable row level security;
revoke all on crm.short_links from public, anon, authenticated;
grant select, insert, update, delete on crm.short_links to service_role;

create or replace function public.crm_create_short_link(p_url text, p_actor text default null)
returns jsonb
language plpgsql security definer set search_path = crm, public, extensions as $$
declare
  v_code text;
  v_alpha text := 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  i int;
begin
  p_url := btrim(p_url);
  if p_url !~* '^https://([a-z0-9-]+\.)*kakauma\.com\.br(/|\?|#|$)' then
    raise exception 'Só links do kakauma.com.br podem ser encurtados';
  end if;
  select code into v_code from crm.short_links where url = p_url;
  if v_code is not null then
    return jsonb_build_object('code', v_code, 'existing', true);
  end if;
  for attempt in 1..20 loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(v_alpha, 1 + floor(random() * length(v_alpha))::int, 1);
    end loop;
    begin
      insert into crm.short_links (code, url, created_by) values (v_code, p_url, p_actor);
      return jsonb_build_object('code', v_code, 'existing', false);
    exception when unique_violation then
      -- the same link created at the same moment: use it; otherwise try another code
      select code into v_code from crm.short_links where url = p_url;
      if v_code is not null then return jsonb_build_object('code', v_code, 'existing', true); end if;
    end;
  end loop;
  raise exception 'could not create a short code';
end;
$$;

-- The destination of a code, counting the click (null: unknown code).
create or replace function public.crm_open_short_link(p_code text) returns text
language sql security definer set search_path = crm, public, extensions as $$
  update crm.short_links set clicks = clicks + 1, last_click_at = now()
   where code = p_code
  returning url
$$;

create or replace function public.crm_list_short_links(p_limit int default 100)
returns table (code text, url text, created_by text, created_at timestamptz, clicks bigint, last_click_at timestamptz)
language sql stable security definer set search_path = crm, public, extensions as $$
  select code, url, created_by, created_at, clicks, last_click_at
    from crm.short_links order by created_at desc limit least(greatest(p_limit, 1), 500)
$$;

do $$
declare fn text;
begin
  foreach fn in array array['crm_create_short_link(text,text)', 'crm_open_short_link(text)',
                            'crm_list_short_links(int)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end;
$$;

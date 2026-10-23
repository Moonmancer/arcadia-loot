-- Rest-Items werden mit der Auszahlung ausgehändigt: Abholung von Rest erst in der Phase „auszahlung“
-- abhaken. Alle anderen Anteile wie bisher ab „abholung“.

create or replace function public.set_picked_up(p_drop bigint, p_user uuid, p_done boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_run bigint;
  v_status text;
begin
  select r.id, r.status into v_run, v_status
  from public.drops d join public.runs r on r.id = d.run_id where d.id = p_drop;
  if v_run is null
     or not (p_user = auth.uid() or public.is_party_seller(public.run_party(v_run))) then
    raise exception 'Keine Berechtigung';
  end if;
  if v_status not in ('abholung', 'verkauf', 'auszahlung') then
    raise exception 'Abholung ist in dieser Phase nicht möglich';
  end if;
  if v_status <> 'auszahlung'
     and exists (select 1 from public.interests where drop_id = p_drop and user_id = p_user and source = 'rest') then
    raise exception 'Rest wird mit der Auszahlung ausgehändigt';
  end if;
  update public.interests
  set picked_up_at = case when p_done then now() end,
      picked_up_by = case when p_done then auth.uid() end
  where drop_id = p_drop and user_id = p_user and share > 0;
  if not found then
    raise exception 'Kein Anteil zum Abholen';
  end if;
end;
$$;

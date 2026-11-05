-- ============================================================
-- Centros de servicio en el monitor (Supabase kkzo, SQL Editor, una vez)
-- Correr ANTES de poner ROBOT_CENTRO en el .env de algún robot.
-- Sin ROBOT_CENTRO, el dungeon usa el centro por defecto de cada robot (index.html → ROBOTS).
-- ============================================================
alter table public.robot_status  add column if not exists centro text;
alter table public.robot_eventos add column if not exists centro text;

-- robot_reportar (modo token) ahora también guarda el centro
create or replace function public.robot_reportar(p_token text, p_tipo text, p_datos jsonb)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not exists (
    select 1 from public.robot_tokens
    where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') and activo
  ) then
    raise exception 'token de robot inválido' using errcode = '42501';
  end if;

  if p_tipo = 'estado' then
    insert into public.robot_status (robot, pc, centro, estado, detalle, llamada, intervalo_seg, version, ultimo_error)
    values (
      left(p_datos->>'robot', 40), left(p_datos->>'pc', 60), left(p_datos->>'centro', 40), p_datos->>'estado',
      left(p_datos->>'detalle', 500), left(p_datos->>'llamada', 40),
      coalesce((p_datos->>'intervalo_seg')::int, 180), left(p_datos->>'version', 20),
      left(p_datos->>'ultimo_error', 500))
    on conflict (robot, pc) do update set
      centro        = coalesce(excluded.centro, public.robot_status.centro),
      estado        = excluded.estado,
      detalle       = excluded.detalle,
      llamada       = excluded.llamada,
      intervalo_seg = excluded.intervalo_seg,
      version       = excluded.version,
      ultimo_error  = case when p_datos ? 'ultimo_error' then excluded.ultimo_error else public.robot_status.ultimo_error end;
  elsif p_tipo = 'evento' then
    insert into public.robot_eventos (robot, pc, centro, tipo, llamada, mensaje)
    values (left(p_datos->>'robot', 40), left(p_datos->>'pc', 60), left(p_datos->>'centro', 40), p_datos->>'tipo',
            left(p_datos->>'llamada', 40), left(p_datos->>'mensaje', 500));
  else
    raise exception 'tipo inválido: %', p_tipo;
  end if;
end $$;

revoke all on function public.robot_reportar(text, text, jsonb) from public;
grant execute on function public.robot_reportar(text, text, jsonb) to anon, authenticated;

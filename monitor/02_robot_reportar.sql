-- ============================================================
-- Reporte con TOKEN (para PCs que no deben tener la service_role)
-- Correr una vez en Supabase kkzo (SQL Editor). Requiere 01_robot_monitor.sql
-- La PC usa la anon key + MONITOR_TOKEN. El token solo sirve para
-- escribir en robot_status / robot_eventos, nada más.
-- ============================================================

-- Tokens: se guarda solo el hash SHA-256 (el token real nunca entra a Supabase)
create table if not exists public.robot_tokens (
  token_hash  text        primary key,
  nota        text,                         -- ej. 'PC guías zona 4'
  activo      boolean     not null default true,
  created_at  timestamptz not null default now()
);
alter table public.robot_tokens enable row level security;   -- sin políticas: anon no la puede leer
revoke all on public.robot_tokens from anon, authenticated;

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
    insert into public.robot_status (robot, pc, estado, detalle, llamada, intervalo_seg, version, ultimo_error)
    values (
      left(p_datos->>'robot', 40), left(p_datos->>'pc', 60), p_datos->>'estado',
      left(p_datos->>'detalle', 500), left(p_datos->>'llamada', 40),
      coalesce((p_datos->>'intervalo_seg')::int, 180), left(p_datos->>'version', 20),
      left(p_datos->>'ultimo_error', 500))
    on conflict (robot, pc) do update set
      estado        = excluded.estado,
      detalle       = excluded.detalle,
      llamada       = excluded.llamada,
      intervalo_seg = excluded.intervalo_seg,
      version       = excluded.version,
      ultimo_error  = case when p_datos ? 'ultimo_error' then excluded.ultimo_error else public.robot_status.ultimo_error end;
  elsif p_tipo = 'evento' then
    insert into public.robot_eventos (robot, pc, tipo, llamada, mensaje)
    values (left(p_datos->>'robot', 40), left(p_datos->>'pc', 60), p_datos->>'tipo',
            left(p_datos->>'llamada', 40), left(p_datos->>'mensaje', 500));
  else
    raise exception 'tipo inválido: %', p_tipo;
  end if;
end $$;

revoke all on function public.robot_reportar(text, text, jsonb) from public;
grant execute on function public.robot_reportar(text, text, jsonb) to anon, authenticated;

-- Dar de alta un token: el script nuevo-token-robot.ps1 te da el INSERT listo (solo con el hash).
-- Revocar:  update public.robot_tokens set activo = false where nota = 'PC guías zona 4';

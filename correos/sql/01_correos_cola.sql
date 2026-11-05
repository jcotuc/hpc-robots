-- ============================================================
-- Robot de correos — cola de notificaciones (Supabase ConsumosCS, SQL Editor, una vez)
-- Las apps / triggers meten filas aquí y el robot las envía por Microsoft 365.
-- ============================================================

-- 1) Cola: una fila = un correo
create table if not exists public.correos_cola (
  id            bigserial   primary key,
  tipo          text        not null,                 -- plantilla: 'autoconsumo_solicitud', 'autoconsumo_resuelto', ...
  para          text[]      not null,                 -- destinatarios
  cc            text[]      not null default '{}',
  datos         jsonb       not null default '{}',    -- valores para la plantilla
  asunto        text,                                 -- opcional: si viene, reemplaza el de la plantilla
  html          text,                                 -- opcional: si viene, reemplaza el cuerpo de la plantilla
  referencia    text,                                 -- ej. número de autoconsumo (sale en el dungeon)
  clave         text        unique,                   -- evita duplicados: 'autoconsumo_solicitud:123'
  estado        text        not null default 'pendiente'
                check (estado in ('pendiente','enviando','enviado','error','cancelado')),
  intentos      int         not null default 0,
  ultimo_error  text,
  tomado_en     timestamptz,
  enviado_en    timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists ix_correos_cola_pend on public.correos_cola (created_at)
  where estado in ('pendiente','enviando');

-- 2) Seguridad: sin políticas = solo service_role (el robot) lee y escribe.
--    Las apps NO insertan directo: lo hacen los triggers con encolar_correo().
alter table public.correos_cola enable row level security;

-- 3) Encolar (lo usan los triggers). Si la clave ya existe no duplica.
create or replace function public.encolar_correo(
  p_tipo text, p_para text[], p_datos jsonb default '{}',
  p_referencia text default null, p_clave text default null, p_cc text[] default '{}'
) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  -- sin destinatarios válidos no se encola
  p_para := array(select distinct lower(trim(x)) from unnest(p_para) x where x ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');
  if coalesce(array_length(p_para, 1), 0) = 0 then return null; end if;
  insert into public.correos_cola (tipo, para, cc, datos, referencia, clave)
  values (p_tipo, p_para, coalesce(p_cc, '{}'), coalesce(p_datos, '{}'), p_referencia, p_clave)
  on conflict (clave) do nothing
  returning id into v_id;
  return v_id;
end $$;

-- 4) El robot toma hasta p_max correos. Si uno quedó "enviando" más de 10 min (robot se cayó), se reintenta.
create or replace function public.correos_tomar(p_max int default 20)
returns setof public.correos_cola
language sql security definer set search_path = public as $$
  update public.correos_cola c
     set estado = 'enviando', tomado_en = now()
   where c.id in (
     select id from public.correos_cola
      where estado = 'pendiente'
         or (estado = 'enviando' and tomado_en < now() - interval '10 minutes')
      order by created_at
      limit p_max
      for update skip locked)
  returning c.*;
$$;

revoke execute on function public.encolar_correo(text, text[], jsonb, text, text, text[]) from public, anon, authenticated;
revoke execute on function public.correos_tomar(int) from public, anon, authenticated;
grant  execute on function public.correos_tomar(int) to service_role;

-- Útiles:
-- select id, tipo, para, estado, intentos, ultimo_error, created_at from correos_cola order by id desc limit 50;
-- update correos_cola set estado = 'pendiente', intentos = 0 where estado = 'error';   -- reintentar los fallidos

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

-- 3b) Encolar AGRUPANDO: mismo p_grupo (ej. 'notif:gar_por_digitador:<id>') = UN solo correo con todos en "Para".
--     Las notificaciones de un mismo evento se insertan en la misma transacción, así que el robot
--     nunca toma el correo a medias. Si ese correo ya se envió, el destinatario tardío va en uno aparte.
create or replace function public.encolar_correo_grupo(
  p_tipo text, p_para text[], p_datos jsonb, p_referencia text, p_grupo text, p_extra text default null
) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  p_para := array(select distinct lower(trim(x)) from unnest(p_para) x where x ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');
  if coalesce(array_length(p_para, 1), 0) = 0 then return null; end if;

  update public.correos_cola c
     set para = array(select distinct x from unnest(c.para || p_para) x order by x)
   where c.clave = p_grupo and c.estado = 'pendiente'
  returning c.id into v_id;
  if v_id is not null then return v_id; end if;

  begin
    insert into public.correos_cola (tipo, para, datos, referencia, clave)
    values (p_tipo, p_para, coalesce(p_datos, '{}'), p_referencia, p_grupo)
    returning id into v_id;
  exception when unique_violation then
    -- el correo del grupo ya salió (o se está enviando): este destinatario va aparte
    v_id := public.encolar_correo(p_tipo, p_para, p_datos, p_referencia, p_grupo || ':' || coalesce(p_extra, md5(random()::text)));
  end;
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

-- 5) Configuración y alertas: si un trigger de correos falla o aparece un tipo de notificación
--    que no conoce, se manda un correo a 'alertas_a' (máx. 1 por hora por motivo).
create table if not exists public.correos_config (clave text primary key, valor text not null);
alter table public.correos_config enable row level security;
insert into public.correos_config (clave, valor) values ('alertas_a', 'jcotuc@hpc.com.gt') on conflict (clave) do nothing;
-- cambiar destinatario: update correos_config set valor = 'otro@hpc.com.gt' where clave = 'alertas_a';

create or replace function public.correos_alerta(p_origen text, p_mensaje text, p_detalle jsonb default '{}')
returns void
language plpgsql security definer set search_path = public as $$
declare v_para text;
begin
  select valor into v_para from public.correos_config where clave = 'alertas_a';
  perform public.encolar_correo('sistema_alerta', array[v_para],
    jsonb_build_object('origen', p_origen, 'mensaje', p_mensaje, 'detalle', p_detalle, 'fecha', now()),
    p_origen, 'alerta:' || p_origen || ':' || left(md5(coalesce(p_mensaje, '')), 8) || ':' || to_char(now() at time zone 'America/Guatemala', 'YYYYMMDDHH24'));
exception when others then
  raise warning 'correos_alerta: %', sqlerrm;  -- la alerta tampoco bloquea nada
end $$;

revoke execute on function public.correos_alerta(text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.encolar_correo(text, text[], jsonb, text, text, text[]) from public, anon, authenticated;
revoke execute on function public.correos_tomar(int) from public, anon, authenticated;
revoke execute on function public.encolar_correo_grupo(text, text[], jsonb, text, text, text) from public, anon, authenticated;
grant  execute on function public.correos_tomar(int) to service_role;

-- Útiles:
-- select id, tipo, para, estado, intentos, ultimo_error, created_at from correos_cola order by id desc limit 50;
-- update correos_cola set estado = 'pendiente', intentos = 0 where estado = 'error';   -- reintentar los fallidos

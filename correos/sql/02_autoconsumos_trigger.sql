-- ============================================================
-- Autoconsumos → correos (Supabase ConsumosCS, SQL Editor). Correr DESPUÉS de 01_correos_cola.sql
--
-- Reusa las notificaciones que la app ya genera (tabla notifications, la campanita):
--   auto_pendiente  → ya existe: aprobadores según región / especial (Proyecto o > Q2,000)
--   auto_autorizado → ya existe: usuarios con rol teleservicio, para crear el número de pedido
--   auto_resuelto   → NUEVO: al solicitante cuando su pedido se autoriza o rechaza (también sale en la campanita)
-- Cada notificación de esos tipos genera un correo en correos_cola. Si algo falla aquí,
-- NO se bloquea el autoconsumo (solo queda un WARNING en los logs de Postgres).
-- ============================================================

-- 1) Notificación al solicitante cuando su pedido se resuelve
create or replace function public.notify_autoconsumo_resuelto()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.estado = 'pendiente' and new.estado in ('autorizado', 'rechazado')
     and nullif(trim(new.solicitante_email), '') is not null then
    insert into public.notifications (recipient_email, app, tipo, titulo, mensaje, link, entity_id)
    values (lower(trim(new.solicitante_email)), 'autoconsumos', 'auto_resuelto',
            case when new.estado = 'autorizado' then 'Pedido autorizado' else 'Pedido rechazado' end,
            case when new.estado = 'rechazado' then 'Motivo: ' || coalesce(new.motivo_rechazo, '') else null end,
            '/autoconsumos', new.pedido_id::text)
    on conflict (lower(recipient_email), tipo, coalesce(entity_id, '')) do nothing;  -- 1 por pedido (vienen varias filas)
  end if;
  return new;
end $$;

drop trigger if exists trg_notify_autoconsumo_resuelto on public.autoconsumos;
create trigger trg_notify_autoconsumo_resuelto
  after update of estado on public.autoconsumos
  for each row execute function public.notify_autoconsumo_resuelto();

-- 2) Notificación nueva de autoconsumos → correo
create or replace function public.correo_desde_notificacion()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_pedido uuid;
  v_datos  jsonb;
  v_tipo   text;
begin
  if new.app <> 'autoconsumos' then return new; end if;
  -- tipos conocidos que NO llevan correo (solo campanita)
  if new.tipo in ('auto_pedido_creado') then return new; end if;
  if new.tipo not in ('auto_pendiente', 'auto_resuelto', 'auto_autorizado') then
    perform public.correos_alerta('autoconsumos', 'Tipo de notificación nuevo sin correo: ' || new.tipo,
      jsonb_build_object('tipo', new.tipo, 'notificacion', new.id));
    return new;
  end if;

  begin
    v_pedido := new.entity_id::uuid;
    v_tipo := case new.tipo when 'auto_pendiente' then 'autoconsumo_solicitud'
                            when 'auto_autorizado' then 'autoconsumo_teleservicio'
                            else 'autoconsumo_resuelto' end;

    -- datos del pedido (cabecera = primera fila, items = todas)
    select jsonb_build_object(
             'numero',      coalesce(max(a.numero_pedido), upper(left(v_pedido::text, 8))),
             'solicitante', max(a.solicitante),
             'centro',      max(l.nombre),
             'tipologia',   max(t.nombre),
             'llamada',     max(a.llamada),
             'comentario',  max(a.comentario),
             'fecha',       min(a.created_at),
             'resultado',   max(a.estado),
             'autorizador', max(a.autorizado_por),
             'resuelto_en', max(a.autorizado_en),
             'motivo_rechazo', max(a.motivo_rechazo),
             'total',       'Q ' || to_char(sum(coalesce(a.precio_unitario, 0) * a.cantidad), 'FM999,999,990.00'),
             'ruta',        new.link,
             'items',       jsonb_agg(jsonb_build_object('sku', a.sku, 'descripcion', a.descripcion, 'cantidad', a.cantidad) order by a.sku))
      into v_datos
      from public.autoconsumos a
      left join public.lugares l on l.id = a.lugar_id
      left join public.tipologias t on t.id = a.tipologia_id
     where a.pedido_id = v_pedido;
    if v_datos->'items' is null or jsonb_typeof(v_datos->'items') <> 'array' then
      raise exception 'autoconsumo % no existe', new.entity_id;
    end if;

    -- un correo por evento con todos los destinatarios en "Para"
    perform public.encolar_correo_grupo(v_tipo, array[new.recipient_email], v_datos,
                                        v_datos->>'numero', 'notif:' || new.tipo || ':' || new.entity_id, new.id::text);
  exception when others then
    raise warning 'correo_desde_notificacion (%): %', new.id, sqlerrm;  -- nunca bloquea la app
    perform public.correos_alerta('autoconsumos', 'No se pudo armar el correo: ' || sqlerrm,
      jsonb_build_object('tipo', new.tipo, 'notificacion', new.id, 'para', new.recipient_email, 'pedido', new.entity_id));
  end;
  return new;
end $$;

drop trigger if exists trg_correo_desde_notificacion on public.notifications;
create trigger trg_correo_desde_notificacion
  after insert on public.notifications
  for each row execute function public.correo_desde_notificacion();

-- ------------------------------------------------------------
-- Antes de probar: ¿a quién le llegaría la solicitud? (aprobadores activos de autoconsumos)
-- select email, tipo, region_id, activo from aprobadores where app = 'autoconsumos' order by tipo, region_id;
-- select id, nombre, region_id from lugares order by nombre;
--
-- Ver la cola:   select id, tipo, para, referencia, estado, ultimo_error, created_at from correos_cola order by id desc limit 20;
-- Apagar correos de autoconsumos (sin tocar la campanita):
--   drop trigger trg_correo_desde_notificacion on public.notifications;

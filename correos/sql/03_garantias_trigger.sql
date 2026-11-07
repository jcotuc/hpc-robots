-- ============================================================
-- Cambios por garantía y Notas de crédito → correos (Supabase ConsumosCS). Correr DESPUÉS de 01.
-- Ambos viven en cambios_garantia (Nota de crédito = tipologia 'Nota de crédito').
--
-- Reusa las notificaciones de la campanita:
--   gar_taller         → ya existe: jefe(s) de taller del centro, para visto bueno
--   gar_pendiente      → ya existe: aprobador regional (o especial si el cambio > Q3,000)
--   gar_por_digitador  → ya existe: digitadores de garantía, cuando se autoriza
--   gar_resuelto       → NUEVO: al solicitante cuando se autoriza o rechaza (campanita); CORREO solo si es rechazo
-- Si algo falla aquí NO se bloquea la garantía (solo WARNING en logs).
-- ============================================================

-- 1) Notificación al solicitante cuando se resuelve (taller o supervisor)
create or replace function public.notify_garantia_resuelto()
returns trigger
language plpgsql security definer set search_path = public as $$
declare v_caso text := case when new.tipologia = 'Nota de crédito' then 'Nota de crédito' else 'Cambio por garantía' end;
begin
  if new.estado in ('autorizado', 'rechazado') and old.estado is distinct from new.estado
     and nullif(trim(new.solicitante_email), '') is not null then
    insert into public.notifications (recipient_email, app, tipo, titulo, mensaje, link, entity_id)
    values (lower(trim(new.solicitante_email)), 'garantia', 'gar_resuelto',
            v_caso || case when new.estado = 'autorizado' then ' autorizado' else ' rechazado' end,
            coalesce(new.llamada, new.sku_nuevo) || case when new.estado = 'rechazado' then ' · Motivo: ' || coalesce(new.motivo_rechazo, '') else '' end,
            '/garantias/mis', new.id::text)
    on conflict (lower(recipient_email), tipo, coalesce(entity_id, '')) do nothing;
  end if;
  return new;
end $$;

drop trigger if exists trg_notify_garantia_resuelto on public.cambios_garantia;
create trigger trg_notify_garantia_resuelto
  after update of estado on public.cambios_garantia
  for each row execute function public.notify_garantia_resuelto();

-- 2) Notificación nueva de garantía → correo
create or replace function public.correo_desde_notificacion_garantia()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  g        public.cambios_garantia%rowtype;
  v_datos  jsonb;
  v_tipo   text;
  v_centro text;
begin
  if new.app <> 'garantia' then return new; end if;
  if new.tipo not in ('gar_taller', 'gar_pendiente', 'gar_por_digitador', 'gar_resuelto') then
    perform public.correos_alerta('garantia', 'Tipo de notificación nuevo sin correo: ' || new.tipo,
      jsonb_build_object('tipo', new.tipo, 'notificacion', new.id));
    return new;
  end if;

  begin
    select * into g from public.cambios_garantia where id = new.entity_id::uuid;
    if not found then raise exception 'cambios_garantia % no existe', new.entity_id; end if;
    -- al solicitante solo se le manda correo si lo RECHAZAN (el autorizado queda solo en la campanita)
    if new.tipo = 'gar_resuelto' and g.estado <> 'rechazado' then return new; end if;
    select nombre into v_centro from public.lugares where id = g.lugar_id;
    v_tipo := case new.tipo when 'gar_taller' then 'garantia_taller'
                            when 'gar_pendiente' then 'garantia_pendiente'
                            when 'gar_por_digitador' then 'garantia_digitador'
                            else 'garantia_resuelto' end;
    v_datos := jsonb_build_object(
      'caso',         case when g.tipologia = 'Nota de crédito' then 'Nota de crédito' else 'Cambio por garantía' end,
      'numero',       coalesce(g.llamada, upper(left(g.id::text, 8))),
      'llamada',      g.llamada,
      'centro',       v_centro,
      'solicitante',  g.solicitante,
      'tipologia',    g.tipologia,
      'sku_viejo',    g.sku_viejo,  'desc_viejo', g.descripcion_viejo,
      'sku_nuevo',    g.sku_nuevo,  'desc_nuevo', g.descripcion_nuevo,
      'precio',       case when g.precio_nuevo is not null then 'Q ' || to_char(g.precio_nuevo, 'FM999,999,990.00') end,
      'comentario',   g.comentario,
      'fecha',        g.created_at,
      'resultado',    g.estado,
      'vb_taller',    g.vb_taller_por,
      'autorizador',  coalesce(g.autorizado_por, g.vb_taller_por),
      'resuelto_en',  coalesce(g.autorizado_en, g.vb_taller_en),
      'motivo_rechazo', g.motivo_rechazo,
      'foto',         coalesce(g.media_url, g.fotos_urls[1]),
      'ruta',         new.link);

    perform public.encolar_correo(v_tipo, array[new.recipient_email], v_datos,
                                  v_datos->>'numero', 'notif:' || new.id::text);
  exception when others then
    raise warning 'correo_desde_notificacion_garantia (%): %', new.id, sqlerrm;  -- nunca bloquea la app
    perform public.correos_alerta('garantia', 'No se pudo armar el correo: ' || sqlerrm,
      jsonb_build_object('tipo', new.tipo, 'notificacion', new.id, 'para', new.recipient_email, 'garantia', new.entity_id));
  end;
  return new;
end $$;

drop trigger if exists trg_correo_desde_notificacion_garantia on public.notifications;
create trigger trg_correo_desde_notificacion_garantia
  after insert on public.notifications
  for each row execute function public.correo_desde_notificacion_garantia();

-- ------------------------------------------------------------
-- Quién recibe:
--   select email, lugar_id from garantia_jefes_taller order by lugar_id;
--   select email, tipo, region_id, activo from aprobadores where app = 'garantia' order by tipo, region_id;
--   select email from garantia_digitadores;
-- Quitar un tipo de correo: sacarlo de la lista del IF de correo_desde_notificacion_garantia.
-- Apagar todos los correos de garantía: drop trigger trg_correo_desde_notificacion_garantia on public.notifications;

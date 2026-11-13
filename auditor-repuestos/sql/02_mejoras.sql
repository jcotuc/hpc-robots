-- =====================================================================
-- Mejoras de la operación de repuestos (Supabase ConsumosCS, SQL Editor, una vez; se puede re-correr)
--  1) rep_existencias_disponible: existencia − cuarentena KB − lo APARTADO en solicitudes de bodega
--  2) rep_trabas_avisadas: qué trabas ya se avisaron por correo (para no repetir)
--  3) rep_tiempos: minutos de cada etapa por solicitud (pedido → CSHP → picking → despacho)
-- =====================================================================

-- 1) Disponible real para el técnico.
--    Apartado = líneas de bodega abiertas (pendiente / cargada / pickeada / con error)
--             + despachadas DESPUÉS de la última lectura aplicada de Kardex (WMS ya las descontó, la app todavía no)
--    Corre como dueño (ve todas las solicitudes) pero solo devuelve filas a usuarios con rol en la app.
CREATE OR REPLACE VIEW public.rep_existencias_disponible AS
WITH corte AS (
  SELECT coalesce(max(creada_en), '-infinity'::timestamptz) AS t
    FROM public.rep_kardex_cargas WHERE estado = 'aplicada'
), ap AS (
  SELECT upper(btrim(l.sku)) AS sku, upper(btrim(l.ubicacion_origen)) AS ubic,
         sum(coalesce(l.cantidad_pickeada, l.cantidad)) AS cant
    FROM public.rep_solicitud_lineas l
    JOIN public.rep_solicitudes s ON s.id = l.solicitud_id
    CROSS JOIN corte
   WHERE NOT l.autoservicio AND l.ubicacion_origen IS NOT NULL AND s.estado <> 'cancelada'
     AND (l.estado IN ('pendiente','cargado_cshp','error_cshp','pickeado','error_despacho')
          OR (l.estado = 'despachado' AND l.despachado_en > corte.t))
   GROUP BY 1, 2
)
SELECT e.sku, e.descripcion, e.ubicacion, e.bodega, e.existencia, e.cuarentena,
       coalesce(ap.cant, 0) AS apartado,
       greatest(e.existencia - e.cuarentena - coalesce(ap.cant, 0), 0) AS disponible,
       e.actualizado_en
  FROM public.rep_existencias e
  LEFT JOIN ap ON ap.sku = upper(btrim(e.sku)) AND ap.ubic = upper(btrim(e.ubicacion))
 WHERE coalesce(auth.role(), '') = 'service_role' OR public.rep_rol(auth.uid()) IS NOT NULL;
REVOKE ALL ON public.rep_existencias_disponible FROM anon, public;
GRANT SELECT ON public.rep_existencias_disponible TO authenticated, service_role;

-- 2) Trabas ya avisadas (lo usa el auditor; una clave = una traba de un objeto en un estado)
CREATE TABLE IF NOT EXISTS public.rep_trabas_avisadas (
  clave text PRIMARY KEY,
  avisado_en timestamptz NOT NULL DEFAULT now(),
  num_llamada text,
  detalle text,
  correo_id bigint
);
GRANT ALL ON public.rep_trabas_avisadas TO service_role;
ALTER TABLE public.rep_trabas_avisadas ENABLE ROW LEVEL SECURITY;

-- 3) Tiempos por solicitud (minutos). Solo robots / SQL Editor.
CREATE OR REPLACE VIEW public.rep_tiempos AS
SELECT s.id, s.num_llamada, s.solicitante_nombre, s.estado, s.created_at,
       (s.created_at AT TIME ZONE 'America/Guatemala')::date AS dia,
       count(*) AS lineas,
       bool_or(l.autoservicio) AS tiene_kb,
       round((extract(epoch FROM min(l.cargado_cshp_en) - s.created_at) / 60)::numeric, 1) AS min_a_cshp,
       round((extract(epoch FROM max(l.pickeado_en) - min(l.cargado_cshp_en)) / 60)::numeric, 1) AS min_bodega,
       round((extract(epoch FROM max(l.despachado_en) - coalesce(max(l.pickeado_en), min(l.cargado_cshp_en))) / 60)::numeric, 1) AS min_despacho,
       round((extract(epoch FROM max(l.despachado_en) - s.created_at) / 60)::numeric, 1) AS min_total
  FROM public.rep_solicitudes s
  JOIN public.rep_solicitud_lineas l ON l.solicitud_id = s.id
 WHERE s.estado <> 'cancelada'
 GROUP BY s.id;
REVOKE ALL ON public.rep_tiempos FROM anon, authenticated, public;
GRANT SELECT ON public.rep_tiempos TO service_role;

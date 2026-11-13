-- =====================================================================
-- Robot Kardex → inventario de la app de repuestos (Supabase ConsumosCS)
-- Correr UNA vez en: Supabase ConsumosCS > SQL Editor
--
-- Idea: el robot NO escribe en rep_existencias. Sube lo que leyó de WMS a
-- rep_kardex_existencias y la función rep_kardex_comparar cruza y (si
-- kardex_modo = 'aplicar') corrige rep_existencias en una sola transacción.
--
-- Regla de apartados (según la lógica actual de la app):
--   * Líneas normales (bodega): la app NUNCA descuenta existencia; WMS baja al
--     despachar en HH. Copiar WMS es correcto.
--   * Autoservicio KB: al pedir sube "cuarentena"; al confirmar la descarga baja
--     existencia y cuarentena. Se compara contra la HORA de la lectura de Kardex
--     (rep_kardex_cargas.creada_en, se crea justo antes de "Actualizar"):
--       - despachado en HH ANTES de la lectura y descarga sin confirmar: WMS ya lo
--         descontó y la app lo va a descontar otra vez → +cantidad
--       - despachado y confirmado DESPUÉS de la lectura: la app ya lo descontó y la
--         foto de WMS todavía no → −cantidad
--       - despachado después de la lectura y sin confirmar: no se ajusta (al
--         confirmar, la app lo descuenta y queda correcto)
--     Así no hace falta pausar a los robots de otras PCs.
--   objetivo = existencia WMS + ajuste KB (columna pendiente_descontar)
--   Nunca se deja existencia < cuarentena (eso queda "revisar").
-- =====================================================================

-- 1) Corridas del robot
CREATE TABLE IF NOT EXISTS public.rep_kardex_cargas (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  creada_en timestamptz NOT NULL DEFAULT now(),
  consulta_en timestamptz,                -- cuando se dio "Actualizar" en Kardex
  pc text,
  origen text NOT NULL DEFAULT 'kardex' CHECK (origen IN ('kardex','archivo')),
  filas int NOT NULL DEFAULT 0,           -- filas subidas (CS/KB de todas las bodegas)
  estado text NOT NULL DEFAULT 'cargando'
    CHECK (estado IN ('cargando','lista','comparada','aplicada','rechazada','error')),
  resumen jsonb NOT NULL DEFAULT '{}'::jsonb,
  motivo text,
  aplicada_en timestamptz
);

-- 2) Lo que dijo WMS en cada corrida (se borra solo a los 15 días)
CREATE TABLE IF NOT EXISTS public.rep_kardex_existencias (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  carga_id bigint NOT NULL REFERENCES public.rep_kardex_cargas(id) ON DELETE CASCADE,
  sku text NOT NULL,
  ubicacion text NOT NULL,
  descripcion text,
  bodega text,
  existencia numeric NOT NULL
);
CREATE INDEX IF NOT EXISTS rep_kardex_exist_carga ON public.rep_kardex_existencias (carga_id);

-- 3) Resultado del cruce (solo lo que NO cuadra; lo igual no se guarda)
CREATE TABLE IF NOT EXISTS public.rep_kardex_diferencias (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  carga_id bigint NOT NULL REFERENCES public.rep_kardex_cargas(id) ON DELETE CASCADE,
  sku text NOT NULL,
  ubicacion text NOT NULL,
  sku_app text,                 -- llave original en rep_existencias (si existe)
  ubicacion_app text,
  descripcion text,
  bodega text,
  app_existencia numeric,       -- lo que tenía la app (null = no existía)
  app_cuarentena numeric NOT NULL DEFAULT 0,
  wms_existencia numeric,       -- lo que dijo WMS (null = no aparece en WMS)
  pendiente_descontar numeric NOT NULL DEFAULT 0,
  objetivo numeric NOT NULL,    -- lo que debería tener la app
  diferencia numeric NOT NULL,  -- objetivo - app
  accion text NOT NULL CHECK (accion IN ('actualizar','nuevo','a_cero','revisar')),
  motivo text,
  aplicado boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS rep_kardex_dif_carga ON public.rep_kardex_diferencias (carga_id, accion);

GRANT ALL ON public.rep_kardex_cargas, public.rep_kardex_existencias, public.rep_kardex_diferencias TO service_role;
GRANT SELECT ON public.rep_kardex_cargas, public.rep_kardex_diferencias TO authenticated;
ALTER TABLE public.rep_kardex_cargas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rep_kardex_existencias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rep_kardex_diferencias ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rep_kardex_cargas_ver ON public.rep_kardex_cargas;
CREATE POLICY rep_kardex_cargas_ver ON public.rep_kardex_cargas FOR SELECT TO authenticated
  USING (public.rep_es_bodega(auth.uid()));
DROP POLICY IF EXISTS rep_kardex_dif_ver ON public.rep_kardex_diferencias;
CREATE POLICY rep_kardex_dif_ver ON public.rep_kardex_diferencias FOR SELECT TO authenticated
  USING (public.rep_es_bodega(auth.uid()));

-- 4) Configuración (se cambia con UPDATE en rep_config)
INSERT INTO public.rep_config (clave, valor) VALUES
  ('robot_kardex_activo', 'true'::jsonb),        -- switch del robot
  ('kardex_modo', '"corroborar"'::jsonb),        -- 'corroborar' (solo compara) | 'aplicar' (corrige)
  ('kardex_bodegas', '[]'::jsonb),               -- bodegas de WMS a tomar; [] = las que ya hay en rep_existencias
  ('kardex_prefijos', '["CS","KB"]'::jsonb),     -- ubicaciones que maneja la app
  ('kardex_umbral', '50'::jsonb),                -- diferencia mayor a esto (unidades) = revisar, no se corrige sola
  ('kardex_min_pct', '80'::jsonb),               -- si trae menos de este % de filas que la corrida anterior = rechazada
  ('kardex_pausa_max_min', '45'::jsonb),         -- la pausa vence sola a los N min (si el robot se cae)
  ('kardex_en_curso', 'false'::jsonb)            -- lo prende/apaga el robot
ON CONFLICT (clave) DO NOTHING;

-- 5) Pausa de los otros robots (solicitud / despacho)
CREATE OR REPLACE FUNCTION public.rep_kardex_pausa(_activar boolean, _pc text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'Solo el robot'; END IF;
  INSERT INTO public.rep_config (clave, valor, actualizado_en)
  VALUES ('kardex_en_curso',
          CASE WHEN _activar THEN jsonb_build_object('desde', now(), 'pc', _pc) ELSE 'false'::jsonb END, now())
  ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = now();
END $$;

CREATE OR REPLACE FUNCTION public.rep_kardex_en_pausa()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce((
    SELECT jsonb_typeof(c.valor) = 'object'
       AND (c.valor->>'desde')::timestamptz > now() - make_interval(mins => coalesce(
             (SELECT (valor #>> '{}')::int FROM public.rep_config WHERE clave = 'kardex_pausa_max_min'), 45))
      FROM public.rep_config c WHERE c.clave = 'kardex_en_curso'), false)
$$;

-- 6) Cruce y (opcional) corrección
CREATE OR REPLACE FUNCTION public.rep_kardex_comparar(_carga_id bigint, _solo_corroborar boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c public.rep_kardex_cargas;
  v_bodegas text[]; v_prefijos text[]; v_like text[];
  v_umbral numeric; v_min_pct numeric; v_modo text; v_aplicar boolean;
  v_filas int; v_prev int; v_alcance int; v_pend int; v_sin_bodega int; v_corte timestamptz;
  v_res jsonb;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'Solo el robot (service_role)'; END IF;
  -- misma llave que rep_guardar_inventario: no choca con una carga manual de Excel
  PERFORM pg_advisory_xact_lock(hashtext('rep_guardar_inventario'));

  SELECT * INTO c FROM public.rep_kardex_cargas WHERE id = _carga_id FOR UPDATE;
  IF c.id IS NULL THEN RAISE EXCEPTION 'La carga % no existe', _carga_id; END IF;
  IF c.estado <> 'lista' THEN RAISE EXCEPTION 'La carga % está en estado % (debe ser lista)', _carga_id, c.estado; END IF;

  -- Configuración
  SELECT array_agg(DISTINCT upper(btrim(x))) INTO v_bodegas
    FROM (SELECT valor FROM public.rep_config WHERE clave = 'kardex_bodegas' AND jsonb_typeof(valor) = 'array') cfg,
         jsonb_array_elements_text(cfg.valor) x
   WHERE btrim(x) <> '';
  IF v_bodegas IS NULL THEN
    SELECT array_agg(DISTINCT upper(btrim(bodega))) INTO v_bodegas
      FROM public.rep_existencias WHERE coalesce(btrim(bodega),'') <> '';
  END IF;
  IF v_bodegas IS NULL THEN
    RAISE EXCEPTION 'No sé qué bodega es Nodus: llena kardex_bodegas en rep_config (ej. ["01"])';
  END IF;
  SELECT coalesce(array_agg(upper(btrim(x))), ARRAY['CS','KB']) INTO v_prefijos
    FROM (SELECT valor FROM public.rep_config WHERE clave = 'kardex_prefijos' AND jsonb_typeof(valor) = 'array') cfg,
         jsonb_array_elements_text(cfg.valor) x;
  v_like := ARRAY(SELECT p || '%' FROM unnest(v_prefijos) p);
  v_umbral  := coalesce((SELECT (valor #>> '{}')::numeric FROM public.rep_config WHERE clave = 'kardex_umbral'), 50);
  v_min_pct := coalesce((SELECT (valor #>> '{}')::numeric FROM public.rep_config WHERE clave = 'kardex_min_pct'), 80);
  v_modo    := coalesce((SELECT valor #>> '{}' FROM public.rep_config WHERE clave = 'kardex_modo'), 'corroborar');
  v_aplicar := NOT coalesce(_solo_corroborar, false) AND v_modo = 'aplicar' AND c.origen = 'kardex';

  -- WMS de la corrida, solo bodegas de Nodus y ubicaciones CS/KB
  DROP TABLE IF EXISTS _kx_wms;
  CREATE TEMP TABLE _kx_wms ON COMMIT DROP AS
    SELECT upper(btrim(sku)) AS sku, upper(btrim(ubicacion)) AS ubic,
           max(descripcion) AS descripcion, max(upper(btrim(bodega))) AS bodega, sum(existencia) AS existencia
      FROM public.rep_kardex_existencias
     WHERE carga_id = _carga_id
       AND upper(btrim(coalesce(bodega,''))) = ANY (v_bodegas)
       AND upper(btrim(ubicacion)) LIKE ANY (v_like)
     GROUP BY 1, 2;
  SELECT count(*) INTO v_filas FROM _kx_wms;

  -- Seguridad: carga incompleta o vacía → no se toca nada
  SELECT (resumen->>'filas_nodus')::int INTO v_prev
    FROM public.rep_kardex_cargas
   WHERE estado IN ('comparada','aplicada') AND id <> _carga_id AND resumen ? 'filas_nodus'
   ORDER BY id DESC LIMIT 1;
  IF v_filas = 0 OR (v_prev IS NOT NULL AND v_prev > 0 AND v_filas < v_prev * v_min_pct / 100.0) THEN
    v_res := jsonb_build_object('estado','rechazada','filas_nodus',v_filas,'filas_anterior',v_prev,
                                'bodegas',to_jsonb(v_bodegas),'min_pct',v_min_pct);
    UPDATE public.rep_kardex_cargas
       SET estado = 'rechazada', resumen = v_res,
           motivo = format('Trajo %s filas de Nodus; la anterior %s (mínimo %s%%). No se tocó el inventario.',
                           v_filas, coalesce(v_prev::text,'-'), v_min_pct)
     WHERE id = _carga_id;
    RETURN v_res;
  END IF;

  -- Nadie más escribe inventario mientras se cruza (los técnicos esperan 1-2 s)
  LOCK TABLE public.rep_existencias IN SHARE ROW EXCLUSIVE MODE;

  -- Ajuste KB según la hora de la lectura (ver encabezado)
  v_corte := coalesce(c.consulta_en, c.creada_en);
  DROP TABLE IF EXISTS _kx_pend;
  CREATE TEMP TABLE _kx_pend ON COMMIT DROP AS
    SELECT sku, ubic, sum(aj) AS cant
      FROM (SELECT upper(btrim(l.sku)) AS sku, upper(btrim(l.ubicacion_origen)) AS ubic,
                   CASE WHEN l.inventario_descontado_en IS NULL AND x.hh_en <= v_corte THEN l.cantidad
                        WHEN l.inventario_descontado_en IS NOT NULL AND l.inventario_descontado_en > v_corte THEN -l.cantidad
                        ELSE 0 END AS aj
              FROM public.rep_solicitud_lineas l
              CROSS JOIN LATERAL (SELECT min(e.created_at) AS hh_en FROM public.rep_eventos e
                                   WHERE e.linea_id = l.id AND e.accion = 'linea_despachada') x
             WHERE l.autoservicio AND l.ubicacion_origen IS NOT NULL
               AND (x.hh_en IS NOT NULL OR l.inventario_descontado_en IS NOT NULL)
               AND coalesce(l.inventario_descontado_en, x.hh_en) > v_corte - interval '30 days') t
     GROUP BY 1, 2
    HAVING sum(aj) <> 0;
  SELECT count(*) INTO v_pend FROM _kx_pend;

  SELECT count(*) INTO v_sin_bodega FROM public.rep_existencias
   WHERE coalesce(btrim(bodega),'') = '' AND upper(btrim(ubicacion)) LIKE ANY (v_like);

  DELETE FROM public.rep_kardex_diferencias WHERE carga_id = _carga_id;

  WITH app AS (
    SELECT e.sku AS sku_app, e.ubicacion AS ubic_app, upper(btrim(e.sku)) AS sku, upper(btrim(e.ubicacion)) AS ubic,
           e.descripcion, upper(btrim(e.bodega)) AS bodega, e.existencia, e.cuarentena
      FROM public.rep_existencias e
     WHERE upper(btrim(coalesce(e.bodega,''))) = ANY (v_bodegas)
       AND upper(btrim(e.ubicacion)) LIKE ANY (v_like)
  ), cruce AS (
    SELECT coalesce(a.sku, w.sku) AS sku, coalesce(a.ubic, w.ubic) AS ubic,
           a.sku_app, a.ubic_app, coalesce(w.descripcion, a.descripcion) AS descripcion,
           coalesce(w.bodega, a.bodega) AS bodega,
           a.existencia AS app_ex, coalesce(a.cuarentena, 0) AS cuar,
           w.existencia AS wms_ex, coalesce(p.cant, 0) AS pend,
           coalesce(w.existencia, 0) + coalesce(p.cant, 0) AS objetivo
      FROM app a
      FULL JOIN _kx_wms w ON w.sku = a.sku AND w.ubic = a.ubic
      LEFT JOIN _kx_pend p ON p.sku = coalesce(a.sku, w.sku) AND p.ubic = coalesce(a.ubic, w.ubic)
  )
  INSERT INTO public.rep_kardex_diferencias
    (carga_id, sku, ubicacion, sku_app, ubicacion_app, descripcion, bodega, app_existencia, app_cuarentena,
     wms_existencia, pendiente_descontar, objetivo, diferencia, accion, motivo)
  SELECT _carga_id, sku, ubic, sku_app, ubic_app, descripcion, bodega, app_ex, cuar, wms_ex, pend, objetivo,
         objetivo - coalesce(app_ex, 0),
         CASE WHEN wms_ex < 0 THEN 'revisar'
              WHEN objetivo < cuar THEN 'revisar'
              WHEN abs(objetivo - coalesce(app_ex, 0)) > v_umbral THEN 'revisar'
              WHEN sku_app IS NULL THEN 'nuevo'
              WHEN wms_ex IS NULL THEN 'a_cero'
              ELSE 'actualizar' END,
         CASE WHEN wms_ex < 0 THEN 'WMS en negativo'
              WHEN objetivo < cuar THEN format('WMS deja %s pero hay %s apartados en autoservicio (cuarentena)', objetivo, cuar)
              WHEN abs(objetivo - coalesce(app_ex, 0)) > v_umbral THEN format('Diferencia de %s, mayor al umbral %s', objetivo - coalesce(app_ex, 0), v_umbral)
              WHEN pend > 0 THEN format('Suma %s despachado(s) en HH antes de la lectura sin descarga confirmada', pend)
              WHEN pend < 0 THEN format('Resta %s confirmado(s) después de la lectura de Kardex', -pend)
              WHEN sku_app IS NULL THEN 'Está en WMS y no en la app'
              WHEN wms_ex IS NULL THEN 'Ya no aparece en WMS'
              ELSE NULL END
    FROM cruce
   WHERE objetivo IS DISTINCT FROM app_ex
     AND NOT (sku_app IS NULL AND objetivo <= 0);

  SELECT count(*) INTO v_alcance FROM public.rep_existencias
   WHERE upper(btrim(coalesce(bodega,''))) = ANY (v_bodegas) AND upper(btrim(ubicacion)) LIKE ANY (v_like);

  IF v_aplicar THEN
    UPDATE public.rep_existencias e
       SET existencia = d.objetivo, actualizado_en = now()
      FROM public.rep_kardex_diferencias d
     WHERE d.carga_id = _carga_id AND d.accion IN ('actualizar','a_cero')
       AND e.sku = d.sku_app AND e.ubicacion = d.ubicacion_app;
    INSERT INTO public.rep_existencias (sku, descripcion, ubicacion, bodega, existencia, actualizado_en)
    SELECT d.sku, d.descripcion, d.ubicacion, d.bodega, d.objetivo, now()
      FROM public.rep_kardex_diferencias d
     WHERE d.carga_id = _carga_id AND d.accion = 'nuevo'
    ON CONFLICT (sku, ubicacion) DO NOTHING;
    UPDATE public.rep_kardex_diferencias SET aplicado = true
     WHERE carga_id = _carga_id AND accion IN ('actualizar','a_cero','nuevo');
  END IF;

  SELECT jsonb_build_object(
           'estado', CASE WHEN v_aplicar THEN 'aplicada' ELSE 'comparada' END,
           'modo', v_modo,
           'filas_nodus', v_filas,
           'filas_anterior', v_prev,
           'en_app', v_alcance,
           'iguales', v_alcance - count(*) FILTER (WHERE accion <> 'nuevo'),
           'actualizar', count(*) FILTER (WHERE accion = 'actualizar'),
           'nuevo', count(*) FILTER (WHERE accion = 'nuevo'),
           'a_cero', count(*) FILTER (WHERE accion = 'a_cero'),
           'revisar', count(*) FILTER (WHERE accion = 'revisar'),
           'ajustes_kb', v_pend,
           'sin_bodega_ignoradas', v_sin_bodega,
           'bodegas', to_jsonb(v_bodegas))
    INTO v_res
    FROM public.rep_kardex_diferencias WHERE carga_id = _carga_id;

  UPDATE public.rep_kardex_cargas
     SET estado = CASE WHEN v_aplicar THEN 'aplicada' ELSE 'comparada' END,
         resumen = v_res,
         aplicada_en = CASE WHEN v_aplicar THEN now() END
   WHERE id = _carga_id;

  -- Limpieza: el detalle WMS de corridas viejas no hace falta
  DELETE FROM public.rep_kardex_existencias
   WHERE carga_id IN (SELECT id FROM public.rep_kardex_cargas WHERE creada_en < now() - interval '15 days');

  RETURN v_res;
END $$;

REVOKE ALL ON FUNCTION public.rep_kardex_pausa(boolean, text), public.rep_kardex_comparar(bigint, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rep_kardex_pausa(boolean, text), public.rep_kardex_comparar(bigint, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.rep_kardex_en_pausa() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.rep_kardex_en_pausa() TO authenticated, service_role;

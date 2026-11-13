-- =====================================================================
-- Auditor de repuestos: resultado de cada revisión (Supabase ConsumosCS, SQL Editor, una vez)
-- Una fila por línea y etapa: 'solicitud' (¿quedó en Repuestos Solicitados de CSHP?)
-- y 'despacho' (¿quedó en Repuestos Registrados con esa ubicación y cantidad?).
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.rep_auditoria (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  creado_en timestamptz NOT NULL DEFAULT now(),
  solicitud_id uuid NOT NULL REFERENCES public.rep_solicitudes(id),
  linea_id uuid NOT NULL REFERENCES public.rep_solicitud_lineas(id),
  num_llamada text NOT NULL,
  etapa text NOT NULL CHECK (etapa IN ('solicitud','despacho')),
  resultado text NOT NULL CHECK (resultado IN ('ok','falla')),
  sku text NOT NULL,
  ubicacion text,
  esperado numeric,
  en_cshp numeric,
  motivo text,
  correo_id bigint,
  UNIQUE (linea_id, etapa)
);
CREATE INDEX IF NOT EXISTS rep_auditoria_fecha ON public.rep_auditoria (creado_en DESC);
CREATE INDEX IF NOT EXISTS rep_auditoria_falla ON public.rep_auditoria (resultado, creado_en DESC);
GRANT ALL ON public.rep_auditoria TO service_role;
GRANT SELECT ON public.rep_auditoria TO authenticated;
ALTER TABLE public.rep_auditoria ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rep_auditoria_ver ON public.rep_auditoria;
CREATE POLICY rep_auditoria_ver ON public.rep_auditoria FOR SELECT TO authenticated
  USING (public.rep_es_bodega(auth.uid()));

INSERT INTO public.rep_config (clave, valor) VALUES ('robot_auditor_activo', 'true'::jsonb)
ON CONFLICT (clave) DO NOTHING;

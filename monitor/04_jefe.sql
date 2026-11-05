-- ============================================================
-- El Jefe del dungeon: hallazgos abiertos / resueltos (Supabase kkzo, SQL Editor, una vez)
-- El robot "jefe" escribe aquí con la service_role; el dungeon solo lee (anon).
-- ============================================================
create table if not exists public.jefe_hallazgos (
  id           bigserial   primary key,
  clave        text        not null,                -- ej. 'caido:guias|HPCPCLOGISTICA', 'correos:error'
  robot        text,                                -- cuarto al que va el jefe
  pc           text,
  centro       text,
  severidad    text        not null default 'media' check (severidad in ('alta','media')),
  titulo       text        not null,
  detalle      text,
  abierto_en   timestamptz not null default now(),
  ultimo_visto timestamptz not null default now(),
  cerrado_en   timestamptz,
  avisado_en   timestamptz                          -- cuándo se mandó correo
);
-- solo un hallazgo ABIERTO por clave
create unique index if not exists ux_jefe_hallazgos_abierto on public.jefe_hallazgos (clave) where cerrado_en is null;
create index if not exists ix_jefe_hallazgos_fecha on public.jefe_hallazgos (abierto_en desc);

alter table public.jefe_hallazgos enable row level security;
drop policy if exists "monitor lectura" on public.jefe_hallazgos;
create policy "monitor lectura" on public.jefe_hallazgos for select to anon, authenticated using (true);

alter publication supabase_realtime add table public.jefe_hallazgos;

-- Útil:  select clave, severidad, titulo, abierto_en, cerrado_en from jefe_hallazgos order by id desc limit 30;

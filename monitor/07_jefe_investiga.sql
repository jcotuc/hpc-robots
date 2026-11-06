-- ============================================================
-- El Jefe investiga y aprende (Supabase kkzo, SQL Editor, una vez)
-- ============================================================
-- 1) Cada hallazgo guarda su investigación
alter table public.jefe_hallazgos add column if not exists causa          text;
alter table public.jefe_hallazgos add column if not exists accion         text;
alter table public.jefe_hallazgos add column if not exists evidencia      text;
alter table public.jefe_hallazgos add column if not exists aprendido      text;
alter table public.jefe_hallazgos add column if not exists patrones       text[];
alter table public.jefe_hallazgos add column if not exists investigado_en timestamptz;

-- 2) Memoria del Jefe: cada causa que encontró, cuántas veces, a qué hora y cuánto tardó en resolverse
create table if not exists public.jefe_aprendizaje (
  patron            text        primary key,     -- ej. 'tecnico_no_existe:walter fernando suevern morales', 'digitadores:cshp_lento'
  robot             text,
  causa             text,
  accion            text,
  ejemplo           text,
  veces             int         not null default 0,
  primera           timestamptz not null default now(),
  ultima            timestamptz not null default now(),
  horas             jsonb       not null default '{}'::jsonb,   -- {"09": 3, "14": 1}
  resueltos         int         not null default 0,
  minutos_resolver  numeric     not null default 0            -- suma (promedio = minutos_resolver / resueltos)
);
alter table public.jefe_aprendizaje enable row level security;
drop policy if exists "monitor lectura" on public.jefe_aprendizaje;
create policy "monitor lectura" on public.jefe_aprendizaje for select to anon, authenticated using (true);
alter publication supabase_realtime add table public.jefe_aprendizaje;
notify pgrst, 'reload schema';

-- Útil: lo que más se repite
-- select patron, veces, causa, accion, round(minutos_resolver / nullif(resueltos,0)) as min_resolver from jefe_aprendizaje order by veces desc;

-- ============================================================
-- Carga de trabajo de cada robot (Supabase kkzo, SQL Editor, una vez)
-- El Jefe la calcula cada 5 min (pendientes reales). El dungeon la usa para mandar
-- a la cafetería a los robots sin trabajo; el Jefe para no alarmar si no hay pendientes.
-- ============================================================
create table if not exists public.robot_carga (
  robot        text        primary key,          -- 'citas','guias','digitadores','correos'
  pendientes   int,                               -- null = no se pudo revisar
  detalle      text,
  revisado_en  timestamptz not null default now()
);
alter table public.robot_carga enable row level security;
drop policy if exists "monitor lectura" on public.robot_carga;
create policy "monitor lectura" on public.robot_carga for select to anon, authenticated using (true);
alter publication supabase_realtime add table public.robot_carga;

-- Hechas hoy según la base (Supabase kkzo, SQL Editor, una vez)
-- El Jefe cuenta en garantias_manuales las NC creadas hoy y lo guarda aquí: el dungeon lo muestra aunque el robot no reporte.
alter table public.robot_carga add column if not exists hoy    int;
alter table public.robot_carga add column if not exists ultima timestamptz;
notify pgrst, 'reload schema';

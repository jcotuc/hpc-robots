-- Reglas que Joshua le enseña al Jefe por Telegram (Supabase kkzo, SQL Editor, una vez)
-- "cuando correos diga 'Outlook' → causa: Outlook cerrado → hacer: abrir Outlook → nivel: atención"
create table if not exists public.jefe_reglas (
  id         bigserial   primary key,
  cuando     jsonb       not null,              -- { robots: [], centros: [], textos: [], desde: hora|null, hasta: hora|null }
  causa      text,
  accion     text,
  nivel      text        check (nivel in ('alta', 'media', 'ignorar')),
  texto      text,                              -- como la escribió Joshua
  activa     boolean     not null default true,
  aplicada   int         not null default 0,
  creada_en  timestamptz not null default now()
);
alter table public.jefe_reglas enable row level security;
drop policy if exists "monitor lectura" on public.jefe_reglas;
create policy "monitor lectura" on public.jefe_reglas for select to anon, authenticated using (true);
notify pgrst, 'reload schema';

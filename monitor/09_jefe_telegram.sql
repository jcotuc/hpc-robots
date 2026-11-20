-- El Jefe aprende de Joshua por Telegram (Supabase kkzo, SQL Editor, una vez)
-- ✅ / ❌ en cada alerta suben o bajan la confianza de la causa; si fue otra, Joshua la escribe y el Jefe la usa desde entonces.
alter table public.jefe_aprendizaje add column if not exists confirmadas   int not null default 0;
alter table public.jefe_aprendizaje add column if not exists rechazadas    int not null default 0;
alter table public.jefe_aprendizaje add column if not exists causa_joshua  text;
alter table public.jefe_aprendizaje add column if not exists accion_joshua text;
notify pgrst, 'reload schema';

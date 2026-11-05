-- ============================================================
-- Monitor de robots HPC — correr una vez en Supabase (SQL Editor)
-- ============================================================

-- 1) Estado actual: 1 fila por robot + PC
create table if not exists public.robot_status (
  robot          text        not null,           -- 'citas','guias','garantias','mimo','digitadores','correos'
  pc             text        not null,           -- hostname de la PC
  estado         text        not null check (estado in ('trabajando','esperando','error')),
  detalle        text,
  llamada        text,                           -- llamada que está procesando
  ultimo_error   text,
  intervalo_seg  int         not null default 180, -- cada cuánto corre (para detectar "caído")
  version        text,
  last_seen      timestamptz not null default now(),
  primary key (robot, pc)
);

-- last_seen lo pone el servidor (evita falsos "caído" por reloj desfasado en la PC)
create or replace function public.robot_status_touch() returns trigger
language plpgsql as $$ begin new.last_seen := now(); return new; end $$;

drop trigger if exists trg_robot_status_touch on public.robot_status;
create trigger trg_robot_status_touch before insert or update on public.robot_status
for each row execute function public.robot_status_touch();

-- 2) Bitácora de eventos (ok / error / info)
create table if not exists public.robot_eventos (
  id          bigserial   primary key,
  robot       text        not null,
  pc          text        not null,
  tipo        text        not null check (tipo in ('ok','error','info')),
  llamada     text,
  mensaje     text,
  created_at  timestamptz not null default now()
);
create index if not exists ix_robot_eventos_fecha on public.robot_eventos (created_at desc);

-- 3) Resumen del día (hora Guatemala)
create or replace view public.robot_resumen_hoy as
select robot, pc,
       count(*) filter (where tipo = 'ok')    as ok_hoy,
       count(*) filter (where tipo = 'error') as errores_hoy
from public.robot_eventos
where created_at >= (date_trunc('day', now() at time zone 'America/Guatemala') at time zone 'America/Guatemala')
group by robot, pc;

-- 4) Seguridad: el dashboard solo LEE con la anon key.
--    Los robots escriben con la service_role key (salta RLS).
alter table public.robot_status  enable row level security;
alter table public.robot_eventos enable row level security;

drop policy if exists "monitor lectura" on public.robot_status;
create policy "monitor lectura" on public.robot_status  for select to anon, authenticated using (true);
drop policy if exists "monitor lectura" on public.robot_eventos;
create policy "monitor lectura" on public.robot_eventos for select to anon, authenticated using (true);
grant select on public.robot_resumen_hoy to anon, authenticated;

-- 5) Tiempo real para el dungeon
alter publication supabase_realtime add table public.robot_status, public.robot_eventos;

-- 6) (Opcional) limpiar bitácora de más de 30 días — correr manual o con pg_cron
-- delete from public.robot_eventos where created_at < now() - interval '30 days';

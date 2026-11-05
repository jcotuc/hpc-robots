-- ============================================================
-- Órdenes del Jefe para los robots (Supabase ConsumosCS, SQL Editor, una vez)
-- El Jefe las crea; Digitadores las ejecuta y las marca. Solo service_role (sin políticas).
-- ============================================================
create table if not exists public.jefe_ordenes (
  id            bigserial   primary key,
  num_llamada   text        not null,
  accion        text        not null check (accion in ('cambiar_sku')),
  sku_nuevo     text,                    -- SKU del formulario (Bandeja) que se pondrá en CSHP
  sku_cshp      text,                    -- SKU que tenía CSHP cuando el Jefe decidió
  motivo        text,                    -- por qué el Jefe lo autorizó (ej. misma familia ELECTRICA)
  estado        text        not null default 'pendiente' check (estado in ('pendiente','ejecutada','cancelada')),
  creada_en     timestamptz not null default now(),
  ejecutada_en  timestamptz,
  resultado     text
);
-- una sola orden pendiente por llamada y acción
create unique index if not exists ux_jefe_ordenes_pend on public.jefe_ordenes (num_llamada, accion) where estado = 'pendiente';
alter table public.jefe_ordenes enable row level security;

-- Útil:  select num_llamada, accion, sku_cshp, sku_nuevo, estado, motivo, creada_en from jefe_ordenes order by id desc limit 30;
-- Cancelar una:  update jefe_ordenes set estado = 'cancelada' where num_llamada = 'LLS21-...' and estado = 'pendiente';

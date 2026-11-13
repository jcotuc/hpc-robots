-- La comparación de ~25,000 filas tarda más que el límite por defecto de la API (8 s).
-- Sube el límite SOLO para service_role (lo usan los robots, nunca la app ni los técnicos).
-- Correr UNA vez en Supabase ConsumosCS > SQL Editor.
ALTER ROLE service_role SET statement_timeout = '120s';
NOTIFY pgrst, 'reload config';

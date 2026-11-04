# Worker Citas → CSHP

Crea en CSHP la llamada de servicio de cada equipo en **Pendiente** (ya tiene SKU) y la marca **Completado** con su número.

## Flujo por equipo
1. Buscar cliente **solo por teléfono** (últimos 8 dígitos; no se busca por NIT) → si no aparece, crea el cliente (nombre de quien entrega, NIT, dirección, departamento, municipio y teléfono de la cita).
2. Crear llamada: cliente + SKU + descripción `CITA <ID>: <falla>` + `Dirección de envío: …` (tipología por defecto, status queda abierto).
3. Registrar log tipo 1 con detalle `CITA`.
4. Guardar número de llamada en Supabase → Completado.

Si algo no se puede resolver solo, el equipo queda en **Revisar** con el motivo (se ve en la pestaña Todos).
Si la llamada ya se creó, el script **nunca** la vuelve a crear.

## Instalar y correr
Guía completa: [`docs/SETUP-WORKER-WINDOWS.md`](../docs/SETUP-WORKER-WINDOWS.md)

Desde la raíz del repo (igual que en garantías):
```
npm.cmd run sync:instalar   una vez: instala Playwright y Chromium
npm.cmd run sync:buscar     QA, solo busca clientes (no crea nada)
npm.cmd run sync            QA, crea llamadas mostrando el navegador
npm.cmd run sync:prod       producción
```
Credenciales en `.env` (copiar de `.env.example`). La tarea programada (`programar-tarea.cmd`) usa `AMBIENTE` del `.env`.

Las llamadas se crean en **Centro de Servicio Zona 4** (CSHP pone por defecto el centro del usuario, p. ej. Guate Z5). Para usar otro, en `.env`: `CSHP_CENTRO=Centro de Servicio …` (texto igual al de la lista en CSHP).

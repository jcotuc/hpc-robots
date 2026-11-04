# Worker MiMO → CSHP

Crea en CSHP la llamada de servicio de cada equipo de MiMO en **Pendiente** (el mostrador ya le puso SKU) y lo marca **Completado** con su número. Después aparece en **Por imprimir** en el mostrador.

## Flujo por equipo
1. Buscar cliente: teléfono → NIT → si no aparece, lo crea (nombre de quien entrega, dirección, departamento, municipio y teléfono).
2. Crear llamada en **Centro de Servicio Zona 4**: cliente + SKU + comentario con el machote del mostrador
   (`COMENTARIO` / `ACC` vacío / `INGRESA` / `DPI` / `DIRECCIÓN`).
3. Log tipo 1 (abrir) con detalle `MiMo-N` (o `MiMo-N-1`, `MiMo-N-2` si trajo varias herramientas) → Aceptar.
4. Botón **Cambiar Status** → Nuevo Status **T - En Ruta** → Aceptar.
5. Guarda el número de llamada en Supabase → Completado.

Si algo no se puede resolver solo, el equipo queda en **Revisar** con el motivo. Si la llamada ya se creó, **nunca** se vuelve a crear.

## Instalar y correr (Windows, desde la raíz del repo)
```
npm.cmd run sync:instalar   una vez: instala Playwright y Chromium
setup.cmd            crea .env (o copia .env.example como .env)
npm.cmd run sync:probar     revisa .env, Supabase y CSHP
npm.cmd run sync:buscar     QA, solo busca clientes (no crea nada)
npm.cmd run sync            QA, crea llamadas mostrando el navegador
npm.cmd run sync:prod       producción
programar-tarea.cmd  tarea programada "HPC MiMO CSHP" cada 10 minutos (usa AMBIENTE del .env)
```
Para ver el navegador en producción: `node --env-file=.env sync-mimo.mjs --prod --visible`.

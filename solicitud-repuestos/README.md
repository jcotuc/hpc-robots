# Robot de solicitud de repuestos → CSHP

Con el **usuario genérico de técnico**: abre la llamada, lee el **número SAP** (lo usa el robot de despacho en HH),
asigna el técnico y agrega los repuestos solicitados. Agregar guarda al instante en CSHP.

Reglas: técnico igual → no toca · vacío → asigna · **otro técnico → se detiene** · repuesto ya en la llamada → no lo duplica ·
después de cada Agregar verifica que el repuesto aparezca.

## Comandos (PowerShell, en C:\Users\jcotuc\source\repos\hpc-robots\solicitud-repuestos)
```
npm.cmd install           primera vez
npm.cmd run verificar     revisa conexión con la app (Supabase) y pendientes. Solo lee
npm.cmd run qa            solicitudes de la app contra CSHP QA (visible, lento)
npm.cmd run prod:visible  solicitudes de la app contra CSHP producción (visible)
npm.cmd run prod          igual, sin navegador
npm.cmd run prueba        QA con PRUEBA_* del .env, sin Supabase
npm.cmd run leer          QA, solo lee la llamada de prueba
```
Solo procesa si en la app (Admin) está encendido **robot_solicitud_activo**.
Estados: solicitud `pendiente` → `en_cshp` (+ num_sap) o `error_cshp` (+ motivo) · línea `cargado_cshp` / `error_cshp`.
Un `error_cshp` no se reintenta solo: se revisa y se vuelve a poner en `pendiente`.

## Ver qué pasó
`logs\resumen-AAAA-MM-DD.log` · `logs\detalle-AAAA-MM-DD.log` · `capturas\` · `registro.json`


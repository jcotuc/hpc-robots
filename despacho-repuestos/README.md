# Robot de despacho de repuestos → CSHP HH

Con el **usuario de bodega**: HH → "Respuestos Llamada" → **número SAP** + Enter → por cada pantalla
identifica el SKU, pone **ubicación de origen** y **cantidad pickeada** → Submit.

Reglas: solo despacha SKU pickeados en la app · si la pantalla muestra otro SKU o no avanza tras Submit **se detiene**
(nunca repite Submit: no duplica) · cualquier mensaje de error de HH lo detiene.

## Comandos (PowerShell, en C:\Users\jcotuc\source\repos\hpc-robots\despacho-repuestos)
```
npm.cmd install           primera vez
npm.cmd run leer          QA: entra con PRUEBA_SAP y muestra la pantalla. NO despacha
npm.cmd run prueba        QA: despacha PRUEBA_DESPACHO (SKU:cantidad:ubicación)
npm.cmd run qa            líneas pickeadas de la app contra HH QA
npm.cmd run prod:visible  líneas pickeadas de la app contra HH producción
```
App: líneas `pickeado` de solicitudes `completa` con `num_sap` → `despachado` / `error_despacho`.
Solo trabaja si **robot_despacho_activo** está encendido en la app.

Logs: `logs\` · capturas: `capturas\`

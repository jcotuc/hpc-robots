# Robot de guías y diagnósticos → CSHP

Busca en CSHP las llamadas de **HPCS016** en status **106** y por cada una:

1. Abre la llamada → **Cambiar Status** → Aceptar
2. **Guía de envío** → Imprimir en `IMPRESORA_GUIA`
3. **Diagnóstico** → Imprimir en `IMPRESORA_DIAGNOSTICO`
4. **Aceptar** → vuelve a buscar y sigue con la siguiente (recorre todas, aunque haya varias páginas)

Imprime sin diálogo (`--kiosk-printing`): antes de cada documento cambia la impresora predeterminada de Windows y al final deja la original.

Si una llamada ya cambió de status y algo falla después, **la corrida se detiene** y la llamada queda en `registro.json` para revisarla a mano. Nunca se reprocesa sola.

## Instalar y correr (Windows, en esta carpeta)
```
setup.cmd                        instala Playwright/Chromium y crea .env (elige impresoras de una lista)
npm.cmd run probar-impresoras    1 hoja de prueba en cada impresora, sin tocar CSHP
npm.cmd run listar               QA, solo lista llamadas (no cambia nada)
npm.cmd run qa                   QA, procesa e imprime (lento, para verlo)
npm.cmd run prod                 producción
programar-tarea.cmd              tarea "HPC Guias CSHP" cada 3 minutos (usa AMBIENTE del .env)
quitar-tarea.cmd                 elimina la tarea
```
## Ver qué pasó
```
npm.cmd run vivo                   monitor en vivo (o doble clic en monitor.cmd): cada corrida y lo impreso, con totales del día
npm.cmd run log                    resumen de hoy: tabla por llamada + últimas corridas
npm.cmd run log -- 2026-10-22      otro día
npm.cmd run log -- LLS21-550699    historial de una llamada (pasos, impresora, visor, error)
```
Archivos: `logs\resumen-AAAA-MM-DD.log` (una línea por llamada), `logs\detalle-AAAA-MM-DD.log` (todo), `registro.json`, `capturas\`.

Para probar con una sola llamada: en `.env` pon `SOLO_LLAMADAS=LLS123-456`.

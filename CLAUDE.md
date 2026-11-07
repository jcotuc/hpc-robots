# CLAUDE.md — contexto de hpc-robots (léelo antes de tocar nada)

Dueño: Joshua Cotuc (Supervisor de Proyectos, HPC Guatemala). Respuestas en español, compactas y directas.
Comandos PowerShell con rutas completas (`C:\Users\jcotuc\source\repos\...`), sin instalaciones que pidan admin.

## Qué es
Repo maestro de los robots que trabajan contra **CSHP** (`https://taller.hpc.com.gt/CSHP`, QA: `tallerqa`) con Playwright,
más el **dungeon** (dashboard pixel-art en Vercel: https://hpc-robots-monitor.vercel.app/, `?demo` = datos simulados)
y el **Jefe** (robot auditor). Node ESM, `.env` por carpeta (`node --env-file=.env`), tareas de Windows (`schtasks`).

## Robots, PCs y tareas
| Carpeta | Hace | PC donde corre en PROD | Tarea | Supabase |
|---|---|---|---|---|
| `citas\` | Crea llamadas desde hpc-citas | HPCLPJCOTUC (Joshua) | HPC Citas CSHP, c/5 min | kkzo |
| `digitadores\` | Digita llamadas en estado Garantía de la Bandeja | HPCLPJCOTUC (**solo una PC**: `registro.json` es local) | HPC Digitadores CSHP, c/3 min, 7–18 | ConsumosCS |
| `correos\` | Envía correos de `correos_cola` (Outlook/M365) | HPCLPJCOTUC | HPC Correos, c/2 min | ConsumosCS |
| `jefe\` | Audita a los robots (ver abajo) | HPCLPJCOTUC | HPC Jefe, **c/3 min**, 6–21 | kkzo + ConsumosCS |
| `guias\` | Status 106 + imprime guía y diagnóstico | HPCPCLOGISTICA (token) | HPC Guias CSHP, c/3 min | solo monitor |
| `garantias\` | Garantías manuales NDC → llamada + TLS - NC Autorizada | PC de oscar.lopez (`C:\Users\oscar.lopez\source\repos\hpc-robots`), token | **manual** (`correr.cmd` / `npm.cmd run prod`) | kkzo |
| `mimo\` | MiMo (quitado del dungeon) | — | — | kkzo |
**Nunca correr el mismo robot en PROD en dos PCs** (duplica trabajo en CSHP). En otra PC usar solo QA / `--solo-listar`.

## Supabase
- **kkzo** `https://kkzovradqpptmsaakqlb.supabase.co`: citas, MiMo, garantias_manuales, y el monitor:
  `robot_status` (PK robot+pc, columna `centro`), `robot_eventos`, vista `robot_resumen_hoy`, `robot_tokens` + RPC `robot_reportar`,
  `robot_carga`, `jefe_hallazgos` (causa, accion, evidencia, aprendido, patrones), `jefe_aprendizaje` (memoria del Jefe).
  SQL en `monitor\01..07_*.sql` (ya corridos hasta 06; 07 = investigación del Jefe).
- **ConsumosCS** `https://buzvogvkfdrlhboyndzy.supabase.co`: Bandeja (`llamadas_actualizaciones`, `llamadas_centros`, `llamadas_tecnicos`,
  `llamadas_estados`…), `correos_cola`, `jefe_ordenes`, `etiquetera_config` (robot_garantia_activo).
- El dashboard usa solo la **anon key** (pública). **Nunca** poner service_role/sb_secret en `monitor\index.html` ni en git
  (GitHub push protection ya lo bloqueó una vez).

## Monitor (`shared\monitor.mjs`)
`crearMonitor(robot, { intervaloSeg, activo, pc, centro })` → trabajando / ok / revisar / error / fin / linea / flush. Solo reporta en PROD.
Modo A: service_role de kkzo (PC de Joshua). Modo B: anon key + `MONITOR_TOKEN` (otras PCs; `nuevo-token-robot.ps1` genera token, Supabase guarda el SHA-256).
Digitadores reporta **un cuarto por centro**: pc = `HPCLPJCOTUC · <centro>`, centro de cada llamada desde la Bandeja
(`Zona 6` de la Bandeja = nivel **Nodus**; mapa `CENTRO_DUNGEON` en `digitadores\digitar-garantia.mjs` y `jefe\revisar.mjs`).

## Dungeon (`monitor\index.html`, Vercel Root Directory = `monitor`)
14 centros = niveles (Nodus·Z6, Zona 4, Chimaltenango, Quiché, Escuintla, Río Hondo, Xela, Cobán, Huehuetenango, Mazatenango, Petén, Jutiapa, El Rancho, Morales; **no hay Zona 5**).
Citas en Zona 4; guías, digitadores, correos, garantías en Nodus. Jefe al centro (oficina global), cafetería = robots sin trabajo.
Estados: trabajando / esperando / durmiendo / error / caído / sin datos / libre. Robots manuales nunca "caídos".
El Jefe camina (nunca se teletransporta); señala la alerta 2 min y luego **sale a investigar** al cuarto, dice la causa y regresa a informar.

## Jefe (`jefe\revisar.mjs` + `jefe\investigar.mjs` + `jefe\cshp.mjs`)
Revisa: CSHP, carga (pendientes reales por robot y por centro), garantías, robots caídos/error, citas, correos, digitadores, SKU.
- SKU Bandeja ≠ CSHP: misma familia → orden `cambiar_sku` en `jefe_ordenes` (Digitadores la ejecuta); otra familia → alerta.
- LLM21/LLS digitadas: audita en CSHP (solo lectura) si pasaron a Logística - Envío cuando debían (envío/Cemaco con OPE-). `AUDITAR_DESDE` en .env.
- Alertas ALTAS → correo a Joshua vía `correos_cola` (tipo `jefe_alerta`). En CSHP **solo lee**.
- Investiga cada hallazgo (reglas, sin IA): causa probable, evidencia, qué hacer; aprende en `jefe_aprendizaje` (veces, hora típica, minutos en resolverse; ≥3 = RECURRENTE).
- Watchdog: cada corrida se cierra sola a los 2.5 min. QA: `node --env-file=.env revisar.mjs --qa` (no escribe nada).

## Cosas a saber
- `.env`, `registro.json`, `centros-dungeon.json`, `auditadas.json`, `logs\`, `capturas\` NO van a git.
- La app de garantías (enum `sync_status_enum`) no tiene `rejected`: filtrar estados en código, no en la URL.
- `garantias_manuales` es escribible con anon key (RLS pendiente de revisar). El dashboard es público y muestra correos en la bitácora.
- Pendientes: riesgos de envío duplicado en correos, RLS de garantias_manuales, privacidad del dashboard, archivar repos viejos.
- Cambios en `shared\` llegan a todas las PCs con `git pull`: probar en QA antes del push.

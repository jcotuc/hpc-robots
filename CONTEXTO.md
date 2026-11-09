# CONTEXTO.md — contexto de hpc-robots (léelo antes de tocar nada)

> `CLAUDE.md` solo importa este archivo (`@CONTEXTO.md`) para que Claude Code lo cargue solo. Editar **aquí**.

Dueño: Joshua Cotuc (Supervisor de Proyectos, HPC Guatemala). Respuestas en español, compactas y directas.
Comandos PowerShell con rutas completas (`C:\Users\jcotuc\source\repos\...`), sin instalaciones que pidan admin.

## PCs de Joshua
| PC | Usuario Windows | Repo | Uso |
|---|---|---|---|
| Principal (HPCLPJCOTUC) | `jcotuc` | `C:\Users\jcotuc\source\repos\hpc-robots` | Corre en PROD: citas, digitadores, correos, jefe, truper |
| Secundaria | `joshu` | `C:\Users\joshu\source\repos\hpc-robots` | Revisar código; robots solo en QA / `--solo-listar` |
Usar la ruta de la PC donde se esté trabajando. Mantener sincronizado con `git pull` / `git push`.

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
| `truper\` | Catálogo Truper → Excel/CSV/JSON (sin precios, sin CSHP) | HPCLPJCOTUC | HPC Truper, **día 1 de cada mes 2:00**, 2–3 h | solo monitor |
| `mimo\` | MiMo (quitado del dungeon) | — | — | kkzo |
| `shared\` | Código común (`monitor.mjs`) | — | — | — |
| `monitor\` | Dungeon (dashboard) + SQL del monitor | Vercel | — | kkzo |
**Nunca correr el mismo robot en PROD en dos PCs** (duplica trabajo en CSHP). En otra PC usar solo QA / `--solo-listar`.

## Flujo de cada robot (detalle en el README.md de cada carpeta)
- **guias**: busca en CSHP llamadas de HPCS016 en status 106 → Cambiar Status → imprime guía (`IMPRESORA_GUIA`) y diagnóstico (`IMPRESORA_DIAGNOSTICO`) sin diálogo (`--kiosk-printing`, cambia la impresora predeterminada y la restaura). Si falla después de cambiar status, se detiene y queda en `registro.json` (nunca reprocesa sola).
- **digitadores**: Bandeja (ConsumosCS) en estado Garantía → en CSHP: resolución + tipología (101 Reparación / 123 Mantenimiento) → status 108 con el técnico → Facturar → solo LLS (o LLM con guía "ENVIO" / Cemaco con OPE-) status 106 Logística - Envío. Bien → digitada; si no → pendiente con motivo. Técnico se empata contra `llamadas_tecnicos` (catálogo de reparación). Switch "Robot digita Garantía" en Administración (etiquetera_config). Ejecuta órdenes del Jefe (cambiar SKU misma familia).
- **citas**: equipos de hpc-citas en Pendiente → busca cliente por teléfono (8 dígitos) o lo crea → crea llamada en Centro de Servicio Zona 4 (`CITA <ID>: <falla>`) → log tipo 1 → guarda número → Completado. Si no puede: Revisar. Nunca crea dos veces.
- **correos**: triggers de ConsumosCS meten filas en `correos_cola` → envía con el Outlook clásico de la PC (`CORREO_MODO=outlook`, sin Azure). Flujos: autoconsumos (solicitud/aprobado/rechazado), garantías/NC, y alertas del Jefe (`jefe_alerta`). QA redirige todo a `REDIRIGIR_A`.
- **garantias**: `garantias_manuales` (kkzo) NDC + sync_status pending → crea llamada (Logística, Cliente SAP, HPCS016, Garantía Herr Manual) → status TLS - NC Autorizada. Manual. Copia de `hpc-garantias/scripts/sync.ts` con reportes al monitor.
- **truper** (`truper\scraper.mjs`): baja el Catálogo Vigente de truper.com/CatVigente (~682 páginas, ~4,807 módulos, ~15,191 productos) solo con HTTP + cheerio (sin navegador, sin IA) → `salida\truper_catalogo.xlsx` (Productos + Especificaciones), `.csv`, `.json`. No trae precios (solo están en imágenes). Lista `codigos.json` + `cache\` se renuevan si tienen >20 días (`DIAS_REFRESCO`); una corrida cortada retoma (`correr.cmd`), `--nuevo` = desde cero; fichas con error no se cachean y se reintentan. Ritmo: `CONCURRENCY`=3, `DELAY_MS`=800 (subir/bajar si da 403/429). Prueba: `npm run prueba` (20 productos, no reporta). Si salen fichas vacías → Truper cambió el HTML: revisar `parseFicha()`.
- **mimo**: kiosko MiMo → crea llamada en Zona 4 → T - En Ruta. Fuera del dungeon por ahora.
- Apps en repos aparte: hpc-citas, hpc-mimo, hpc-garantias (Next.js), ConsumosCS (Bandeja/autoconsumos). Aquí solo van los robots.

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
Además el nivel **Común** (`COMUN` en `index.html`) para robots que no son de un centro de servicio: hoy solo Catálogo Truper (cuarto con estante → compu → hoja de Excel que se llena con el avance).
Citas en Zona 4; guías, digitadores, correos, garantías en Nodus; truper en Común. Jefe al centro (oficina global), cafetería = robots sin trabajo.
Estados: trabajando / esperando / durmiendo / error / caído / sin datos / libre. Robots manuales (`manual: true`: garantías, truper) nunca "caídos".
El Jefe camina (nunca se teletransporta); señala la alerta 2 min y luego **sale a investigar** al cuarto, dice la causa y regresa a informar.

## Jefe (`jefe\revisar.mjs` + `jefe\investigar.mjs` + `jefe\cshp.mjs`)
Revisa: CSHP, carga (pendientes reales por robot y por centro), garantías, truper, robots caídos/error, citas, correos, digitadores, SKU.
Robots manuales en `MANUALES` de `revisar.mjs` (garantias, truper): no se marcan caídos por no reportar.
- Truper (severidad media, sin correo): `truper:pendiente` (catálogo del mes sin bajar desde el día 3), `truper:detenido` (>`TRUPER_DETENIDO_MIN`=30 min sin avance), `truper:error` (>2 % fichas con error o >5 % sin nombre).
- SKU Bandeja ≠ CSHP: misma familia → orden `cambiar_sku` en `jefe_ordenes` (Digitadores la ejecuta); otra familia → alerta.
- LLM21/LLS digitadas: audita en CSHP (solo lectura) si pasaron a Logística - Envío cuando debían (envío/Cemaco con OPE-). `AUDITAR_DESDE` en .env.
- Alertas ALTAS → correo a Joshua vía `correos_cola` (tipo `jefe_alerta`). En CSHP **solo lee**.
- Investiga cada hallazgo (reglas, sin IA): causa probable, evidencia, qué hacer; aprende en `jefe_aprendizaje` (veces, hora típica, minutos en resolverse; ≥3 = RECURRENTE).
- Watchdog: cada corrida se cierra sola a los 2.5 min. QA: `node --env-file=.env revisar.mjs --qa` (no escribe nada).

## Cosas a saber
- `.env`, `registro.json`, `centros-dungeon.json`, `auditadas.json`, `logs\`, `capturas\` NO van a git (truper además: `salida\`, `cache\`, `codigos.json`, `.truper.lock`).
- Al agregar un robot nuevo: actualizar este archivo, el `README.md` raíz, `ROBOTS` en `monitor\index.html` y `NOMBRES` (y `MANUALES` si aplica) en `jefe\revisar.mjs`.
- La app de garantías (enum `sync_status_enum`) no tiene `rejected`: filtrar estados en código, no en la URL.
- `garantias_manuales` es escribible con anon key (RLS pendiente de revisar). El dashboard es público y muestra correos en la bitácora.
- Pendientes: riesgos de envío duplicado en correos, RLS de garantias_manuales, privacidad del dashboard, archivar repos viejos.
- Cambios en `shared\` llegan a todas las PCs con `git pull`: probar en QA antes del push.

## Hacia dónde va (Jefe 2.0) — meta: que el Jefe sea independiente, sin depender de Claude ni de IA externa
1. Telegram: alertas al celular, comandos (/estado, /alertas, /hoy, /aprendido) y botones para confirmar o corregir la causa. Bot solo responde al chat de Joshua; token en `jefe\.env`. Recibir mensajes idealmente con una función en Supabase (contesta aunque la PC esté apagada).
2. Línea base de lo normal por robot / hora / centro y detección de anomalías.
3. Confianza por regla (sube/baja con las confirmaciones) y autonomía que se gana: acciones seguras repetidas se aprueban N veces y luego las hace solo; si falla, vuelve a pedir permiso.
4. Reporte semanal de lo aprendido. Errores no reconocidos se agrupan y se le preguntan a Joshua (una etiqueta = lo reconoce para siempre).


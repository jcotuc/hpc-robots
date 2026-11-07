# hpc-robots — repo maestro de los robots CSHP

| Carpeta | Robot | Tarea programada | Supabase |
|---|---|---|---|
| `guias\` | Cambia status e imprime guía y diagnóstico | "HPC Guias CSHP" · L–S 7:00–20:00 · cada 3 min | solo monitor |
| `digitadores\` | Digita llamadas en Garantía | "HPC Digitadores CSHP" · L–S 7:00–18:00 · cada 3 min | ConsumosCS + monitor |
| `citas\` | Crea llamadas desde hpc-citas | "HPC Citas CSHP" · L–S 5:55–20:25 · cada 5 min | kkzo (citas/MiMo) |
| `mimo\` | Crea llamadas desde MiMO | "HPC MiMO CSHP" · L–S 5:55–20:25 · cada 10 min | kkzo (citas/MiMo) |
| `correos\` | Envía notificaciones (autoconsumos…) por M365 | "HPC Correos" · L–S 7:00–20:00 · cada 2 min | ConsumosCS + monitor |
| `garantias\` | Garantías manuales NDC → llamada + TLS - NC Autorizada | **Manual** (correr.cmd) | kkzo (garantías) |
| `truper\` | Catálogo Truper → Excel/CSV/JSON (sin precios) | "HPC Truper" · día 1 de cada mes 2:00 · 2–3 h | solo monitor |
| `shared\` | Código común (`monitor.mjs`) | — | — |
| `monitor\` | Dungeon de robots (Vercel, Root Directory = `monitor`) + SQL | — | kkzo |

Las apps (hpc-citas, hpc-mimo, ConsumosCS) siguen en sus propios repos. Aquí solo van los robots.

## Instalar en una PC robot (PowerShell)
```powershell
cd C:\Users\jcotuc\source\repos
git clone https://github.com/jcotuc/hpc-robots.git
cd C:\Users\jcotuc\source\repos\hpc-robots\guias      # la carpeta del robot de esa PC
.\setup.cmd                                            # npm install + .env
.\programar-tarea.cmd
```
Migrar desde el repo viejo: copiar `.env` y `registro.json` (si existe) a la carpeta nueva, correr `quitar-tarea.cmd` en la carpeta vieja y `programar-tarea.cmd` en la nueva.

## Actualizar
```powershell
cd C:\Users\jcotuc\source\repos\hpc-robots
git pull
```
Si cambió un `package.json`, correr `npm install` en la carpeta de ese robot.

## Monitor
Cada robot reporta en PROD a `robot_status` / `robot_eventos` (Supabase kkzo). Dos formas, en el `.env` del robot:

| Modo | Para | `.env` |
|---|---|---|
| A · service_role | PCs que ya la tienen (citas, MiMo) | nada extra |
| B · token | PCs sin service_role (guías, digitadores) | `MONITOR_SUPABASE_URL`, `MONITOR_SUPABASE_KEY` = **anon**, `MONITOR_TOKEN` |

Token nuevo (uno por PC):
```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\jcotuc\source\repos\hpc-robots\nuevo-token-robot.ps1 -Nota "PC guias"
```
El token solo puede escribir en el monitor (función `robot_reportar`). Revocar: `update public.robot_tokens set activo = false where nota = 'PC guias';`

SQL (una vez, en orden): `monitor\01_robot_monitor.sql`, `monitor\02_robot_reportar.sql`.
Opcional: `ROBOT_PC=Nombre a mostrar` · `MONITOR_APAGADO=1`.

## Reglas
- Un cambio en `shared\` llega a TODAS las PCs con el próximo `git pull`: probar en QA antes del push.
- Robot nuevo = carpeta nueva con `correr.cmd`, `programar-tarea.cmd`, `.env.example` e `import { crearMonitor } from '../shared/monitor.mjs'`.

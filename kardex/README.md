# Robot Kardex → inventario de la app de repuestos

Lee **ExistenciaWMS** de KardexWmsSap.exe y la cruza con `rep_existencias` (ConsumosCS), que es lo que ven los técnicos en /repuestos.
Python (la app de escritorio se maneja con pywinauto). Reporta al dungeon como `kardex` (Nodus).

## Cómo funciona
1. Prende la pausa (`kardex_en_curso`) → solicitud y despacho se saltan sus corridas · espera `ESPERA_PAUSA_SEG`
2. Kardex → ExistenciaWMS → Actualizar → copia el grid (`kardex_wms.py`)
3. Sube las filas CS/KB a `rep_kardex_existencias` (una carga en `rep_kardex_cargas`)
4. `rep_kardex_comparar` cruza y deja lo que no cuadra en `rep_kardex_diferencias` (+ CSV en `salidas\`)
5. Quita la pausa (siempre, aunque falle)

**Regla:** objetivo = WMS + KB ya despachado en HH sin descarga confirmada. Nunca baja de la cuarentena.
Diferencia > `kardex_umbral`, WMS negativo o menos que lo apartado → **revisar** (no se corrige sola).
Si trae < `kardex_min_pct` % de las filas de la corrida anterior → **rechazada**, no toca nada.

| `kardex_modo` | Qué hace |
|---|---|
| `corroborar` (inicio) | Solo compara y reporta |
| `aplicar` | Corrige `rep_existencias` (actualizar / nuevo / a cero) |

## Comandos (PowerShell, en C:\Users\jcotuc\source\repos\hpc-robots\kardex)
```
py -m pip install --user -r requirements.txt     primera vez (sin admin, Python 64 bits)
py sincronizar.py --estado                       config y últimas corridas. No hace nada
py sincronizar.py --archivo <excel>              prueba con un Excel ya extraído (solo corrobora, no pausa)
py sincronizar.py --corroborar                   corrida real con Kardex, sin corregir
py sincronizar.py                                corrida normal (lo que hace la tarea)
programar-tarea.cmd / quitar-tarea.cmd           tarea "HPC Kardex" L-S 6:30, 12:30, 17:30
```
La sesión de Windows debe estar **desbloqueada** a esas horas. Logs: `logs\` · Excel y diferencias: `salidas\`.

## Config (Supabase ConsumosCS > SQL Editor)
```sql
update rep_config set valor = '"aplicar"' where clave = 'kardex_modo';     -- pasar a corregir
update rep_config set valor = '["01"]'    where clave = 'kardex_bodegas';  -- bodega(s) de Nodus en WMS
update rep_config set valor = 'false'     where clave = 'robot_kardex_activo';  -- apagar
select * from rep_kardex_diferencias where carga_id = (select max(id) from rep_kardex_cargas) order by accion;
```

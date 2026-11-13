# Auditor de repuestos (app ↔ CSHP)

Revisa en CSHP, **solo lectura**, que lo hecho en la app de repuestos (ConsumosCS /repuestos) quedó igual en la llamada.
Separado del Jefe. Cada 3 min. Las diferencias llegan por **correo** (correos_cola → robot de correos), un correo por llamada.

| Etapa | Cuándo | Qué compara |
|---|---|---|
| solicitud | línea cargada a CSHP hace ≥ `ESPERA_MIN` | cantidad pedida en la app = "Solicitado" en **Repuestos Solicitados** (filas del mismo día) |
| despacho | línea despachada hace ≥ `ESPERA_MIN` | total despachado en la app por SKU+ubicación = "Cant." en **Repuestos Registrados** con ese Origen |

**Trabas** (cada corrida, sin abrir CSHP; cada una se avisa una vez, `rep_trabas_avisadas`): solicitud sin cargar a CSHP > `TRABA_PENDIENTE_MIN`,
error al cargar, bodega sin atender > `TRABA_BODEGA_MIN`, pickeado sin despachar > `TRABA_PICKEADO_MIN`, error de despacho,
KB sin descargar > `TRABA_KB_MIN`. **Resumen del día** por correo desde `RESUMEN_HORA` (tiempos por etapa de `rep_tiempos`, auditoría, trabas, Kardex).

Cada línea se audita una vez por etapa (`rep_auditoria`). Si no puede leer CSHP no marca nada y reintenta.
Máx. `MAX_LLAMADAS` por corrida; lo que sobra queda para la siguiente.

## Comandos (PowerShell, en C:\Users\jcotuc\source\repos\hpc-robots\auditor-repuestos)
```
npm.cmd install                    primera vez
npm.cmd run mostrar                revisa y muestra; NO guarda ni manda correo
npm.cmd run mostrar:visible        igual, viendo el navegador
npm.cmd run auditar                corrida normal (lo que hace la tarea)
programar-tarea.cmd                tarea "HPC Auditor Repuestos" c/3 min L-S 6:00-22:00
```
SQL una vez: `sql\01_auditoria.sql` y `sql\02_mejoras.sql` en Supabase ConsumosCS. Apagar: `update rep_config set valor='false' where clave='robot_auditor_activo';`

Ver diferencias: `select * from rep_auditoria where resultado = 'falla' order by creado_en desc;`
Logs: `logs\resumen-AAAA-MM-DD.log` · `logs\detalle-AAAA-MM-DD.log`

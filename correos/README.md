# Robot de correos → Microsoft 365

Envía (desde el Outlook de la PC) las notificaciones que los triggers de **ConsumosCS** meten en `correos_cola`.
Primer flujo: **autoconsumos** (solicitud → autorizador · aprobado/rechazado → solicitante).

```
app ConsumosCS ──trigger──► correos_cola (pendiente) ──robot cada 2 min──► Outlook ──► destinatario
                                                     └──► dungeon (robot "correos")
```

## Instalar (PowerShell)
```powershell
cd C:\Users\jcotuc\source\repos\hpc-robots\correos
.\setup.cmd                    # npm install + .env
npm.cmd run probar -- jcotuc@hpc.com.gt     # prueba de envío (no usa la cola)
npm.cmd run qa                 # procesa la cola mandando todo a REDIRIGIR_A
.\programar-tarea.cmd          # tarea "HPC Correos" cada 2 min, L-S 7:00-20:00
```
SQL (una vez, en Supabase ConsumosCS): `sql\01_correos_cola.sql`, luego `sql\02_autoconsumos_trigger.sql` (ya ajustado).

## Comandos
```
npm.cmd run vivo               monitor en vivo (o doble clic en monitor.cmd)
npm.cmd run listar             cola pendiente / con error (no envía)
npm.cmd run prod               envío real
schtasks /Run /TN "HPC Correos"
Get-Content logs\resumen-AAAA-MM-DD.log
```

## .env
- `AMBIENTE=qa` + `REDIRIGIR_A` → nadie recibe nada salvo tú; el asunto muestra a quién iba.
- `CORREO_MODO=outlook` (por defecto): envía con el **Outlook clásico** de la PC, desde `CORREO_REMITENTE`. Sin Azure ni permisos de admin.
  - Outlook debe estar instalado (el clásico; el "nuevo Outlook" no sirve) y con la cuenta configurada.
  - La tarea corre solo con la sesión de Windows iniciada (la PC puede estar bloqueada, no cerrada la sesión).
  - Si Outlook muestra "un programa intenta enviar correo", es porque el antivirus no está al día: avisar a TI.
- `CORREO_MODO=smtp`: plan B, solo si TI activa SMTP AUTH en el buzón.

## Agregar un tipo de correo
1. Plantilla en `plantillas.mjs`.
2. Trigger en Supabase que llame `encolar_correo('tipo', array['a@hpc.com.gt'], jsonb_build_object(...), referencia, clave)`.

## Alertas
Si un trigger no puede armar un correo (p. ej. Lovable cambió una columna) o aparece un tipo de notificación nuevo,
llega un correo **[ALERTA correos]** a `correos_config.alertas_a` (máx. 1 por hora por motivo). La app nunca se bloquea.
ConsumosCS `AGENTS.md` le indica a Lovable qué no debe cambiar.

## Reintentos
Falla → vuelve a `pendiente` hasta `MAX_INTENTOS`, luego `error` (rojo en el dungeon).
Reintentar: `update correos_cola set estado='pendiente', intentos=0 where estado='error';`

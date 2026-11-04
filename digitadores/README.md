# Robot de digitadores → CSHP

Toma de la **Bandeja** de ConsumosCS (Supabase) las llamadas en estado **Garantía** y las digita en CSHP:
Resolución + Tipología (101 Reparación / 123 Mantenimiento) → status 108 con el técnico → Facturar → (solo LLS) status 106.
Si termina bien la marca **digitada**; si no puede, la deja **pendiente** con el motivo para un digitador.
Solo trabaja si en Administración de Llamadas está activo **"Robot digita Garantía"**.

## Comandos (PowerShell, en C:\Users\jcotuc\source\repos\hpc-robots\digitadores)
```
npm.cmd run vivo             monitor en vivo (o doble clic en monitor.cmd)
npm.cmd run listar:prod      ver qué procesaría en producción (solo lee)
npm.cmd run prod:visible     producción con navegador visible
npm.cmd run prod             producción sin navegador
npm.cmd run prueba           QA con datos de prueba.json (sin Supabase)
.\programar-tarea.cmd        tarea "HPC Digitadores CSHP" cada 3 min, L-S 7:00-18:00
.\quitar-tarea.cmd           elimina la tarea
schtasks /Run /TN "HPC Digitadores CSHP"     correr la tarea ya
schtasks /Query /TN "HPC Digitadores CSHP" /V /FO LIST    estado de la tarea
```

## Ver qué pasó
```
Get-Content logs\resumen-AAAA-MM-DD.log          una línea por llamada
Get-Content logs\detalle-AAAA-MM-DD.log -Tail 40 detalle
Get-Content logs\detalle-AAAA-MM-DD.log -Wait    en vivo
```
Capturas de errores: `capturas\`. Pasos hechos por llamada: `registro.json`.

## .env
- `SOLO_LLAMADAS=LLS21-123456` procesa solo esa(s). Vacío = todas.
- `MAX_LLAMADAS=1` máximo por corrida.
- Pausar el robot: apagar el switch en Administración (no hace falta tocar la PC).

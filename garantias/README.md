# Robot de garantías manuales (NDC)

Toma de `garantias_manuales` (Supabase kkzo) las garantías **NDC** con `sync_status = pending`, crea la llamada en CSHP y la pasa a **TLS - NC Autorizada**. Se corre **a mano** (no tiene tarea programada).

## Instalar en la PC (PowerShell, sin admin)
```powershell
cd C:\Users\jcotuc\source\repos\hpc-robots\garantias
.\setup.cmd                       # npm install + navegador + .env
notepad .env                      # mismos datos que .env.local de la app + monitor
```

## Correr
- Producción: **doble clic en `correr.cmd`** (deja log en `logs\AAAA-MM-DD.log`)
- QA: `npm.cmd run qa`

## Dungeon
Reporta en producción como robot `garantias` (centro Nodus). Sin NDC pendientes → descansa en la cafetería. Con NDC pendientes y sin correrlo → el Jefe avisa "hay que correr Garantías".

# Genera un token para que una PC robot reporte al monitor SIN la service_role.
# Uso (sin admin):
#   powershell -ExecutionPolicy Bypass -File C:\Users\jcotuc\source\repos\hpc-robots\nuevo-token-robot.ps1 -Nota "PC guias"
# Supabase solo guarda el HASH; el token real va unicamente en el .env de esa PC.
param([string]$Nota = 'PC robot')
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$token = ([BitConverter]::ToString($bytes) -replace '-', '').ToLower()
$sha = [System.Security.Cryptography.SHA256]::Create()
$hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($token))) -replace '-', '').ToLower()
Write-Host ''
Write-Host '1) Supabase kkzo > SQL Editor, correr:' -ForegroundColor Yellow
Write-Host "insert into public.robot_tokens (token_hash, nota) values ('$hash', '$Nota');"
Write-Host ''
Write-Host '2) En el .env del robot (esa PC), agregar:' -ForegroundColor Yellow
Write-Host 'MONITOR_SUPABASE_URL=https://kkzovradqpptmsaakqlb.supabase.co'
Write-Host 'MONITOR_SUPABASE_KEY=<anon key de kkzo, la misma de monitor\index.html>'
Write-Host "MONITOR_TOKEN=$token"
Write-Host ''

# Configura el worker Citas -> CSHP en esta PC (Windows).
# Ejecutar con doble clic en setup.cmd (o: powershell -ExecutionPolicy Bypass -File setup.ps1)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
Write-Host ''
Write-Host '=== Worker Citas -> CSHP: configuracion ===' -ForegroundColor Cyan

# 1. Node.js 20 o superior
try { $v = (node --version) } catch { $v = $null }
if (-not $v) { Write-Host 'Node.js no esta instalado. Descargalo de https://nodejs.org (version LTS) y vuelve a correr setup.' -ForegroundColor Red; exit 1 }
if ([int]($v.TrimStart('v').Split('.')[0]) -lt 20) { Write-Host "Node $v es muy viejo. Instala la version LTS de https://nodejs.org" -ForegroundColor Red; exit 1 }
Write-Host "[1/3] Node $v OK" -ForegroundColor Green

# 2. Dependencias y navegador
Write-Host '[2/3] Instalando dependencias y Chromium (la primera vez tarda unos minutos)...'
npm.cmd install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Write-Host 'Fallo npm install' -ForegroundColor Red; exit 1 }
npx.cmd playwright install chromium
if ($LASTEXITCODE -ne 0) { Write-Host 'Fallo la instalacion de Chromium' -ForegroundColor Red; exit 1 }
Write-Host '[2/3] Dependencias OK' -ForegroundColor Green

# 3. Archivo .env (credenciales; nunca se sube a GitHub)
# Lee un dato oculto. Ctrl+V NO pega aqui (guarda un caracter invisible): se pega con CLIC DERECHO
function Leer-Secreto($texto) {
  while ($true) {
    $s = Read-Host $texto -AsSecureString
    $v = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
    if ($v -and $v -notmatch '[\x00-\x1f]') { return $v.Trim() }
    Write-Host '  No se leyo bien. Pega con CLIC DERECHO (no Ctrl+V) y presiona Enter.' -ForegroundColor Yellow
  }
}
$crear = $true
if (Test-Path .env) {
  $r = Read-Host '[3/3] Ya existe .env. Reemplazarlo? (s/N)'
  if ($r -ne 's') { $crear = $false; Write-Host '[3/3] Se conserva el .env actual' -ForegroundColor Green }
}
if ($crear) {
  Write-Host '[3/3] Datos de conexion:'
  $amb = Read-Host '  Ambiente para la tarea programada (qa/prod) [qa]'
  if ($amb -ne 'prod') { $amb = 'qa' }
  $usuario = Read-Host '  Usuario CSHP'
  $pass = Leer-Secreto '  Contrasena CSHP'
  $key = Leer-Secreto '  Supabase service_role key (Supabase > Settings > API)'
  $solo = Read-Host '  Solo estas citas, ej. 1000,1001 (Enter = todas)'
  $contenido = @"
AMBIENTE=$amb
CSHP_QA_URL=https://tallerqa.hpc.com.gt/CSHP
CSHP_PROD_URL=https://taller.hpc.com.gt/CSHP
CSHP_USUARIO=$usuario
CSHP_PASSWORD='$pass'
SUPABASE_URL=https://kkzovradqpptmsaakqlb.supabase.co
SUPABASE_SERVICE_ROLE_KEY='$key'
MAX_EQUIPOS=20
SOLO_CITAS=$solo
"@
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot '.env'), $contenido, (New-Object Text.UTF8Encoding $false))
  Write-Host "[3/3] .env creado (tarea programada: $amb)" -ForegroundColor Green
}

Write-Host ''
Write-Host 'Listo. Siguientes pasos:' -ForegroundColor Cyan
Write-Host '  npm.cmd run sync:buscar  (en la raiz del repo) prueba en QA sin crear nada'
Write-Host '  npm.cmd run sync         (en la raiz del repo) crea llamadas en QA viendo el navegador'
Write-Host '  programar-tarea.cmd      deja corriendo el worker cada 5 minutos'

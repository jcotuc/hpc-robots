# Configura el robot de guias y diagnosticos en esta PC (Windows).
# Ejecutar con doble clic en setup.cmd
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
Write-Host ''
Write-Host '=== Robot de guias y diagnosticos CSHP: configuracion ===' -ForegroundColor Cyan

# 1. Node.js 20 o superior
try { $v = (node --version) } catch { $v = $null }
if (-not $v) { Write-Host 'Node.js no esta instalado. Descargalo de https://nodejs.org (version LTS).' -ForegroundColor Red; exit 1 }
if ([int]($v.TrimStart('v').Split('.')[0]) -lt 20) { Write-Host "Node $v es muy viejo. Instala la version LTS." -ForegroundColor Red; exit 1 }
Write-Host "[1/4] Node $v OK" -ForegroundColor Green

# 2. Dependencias y navegador (si MiMO o citas ya lo instalaron, se reutiliza)
Write-Host '[2/4] Instalando dependencias y Chromium...'
npm.cmd install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Write-Host 'Fallo npm install' -ForegroundColor Red; exit 1 }
npx.cmd playwright install chromium
if ($LASTEXITCODE -ne 0) { Write-Host 'Fallo la instalacion de Chromium' -ForegroundColor Red; exit 1 }
Write-Host '[2/4] Dependencias OK' -ForegroundColor Green

# 3. Que Windows NO cambie solo la impresora predeterminada (el robot la cambia por documento)
Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Windows' -Name LegacyDefaultPrinterMode -Value 1 -Type DWord
Write-Host '[3/4] "Windows administra mi impresora predeterminada" desactivado' -ForegroundColor Green

# 4. Archivo .env
function Leer-Secreto($texto) {
  while ($true) {
    $s = Read-Host $texto -AsSecureString
    $v = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
    if ($v -and $v -notmatch '[\x00-\x1f]') { return $v.Trim() }
    Write-Host '  No se leyo bien. Pega con CLIC DERECHO (no Ctrl+V) y presiona Enter.' -ForegroundColor Yellow
  }
}
function Elegir-Impresora($texto, $lista) {
  while ($true) {
    $n = Read-Host $texto
    if ($n -match '^\d+$' -and [int]$n -ge 1 -and [int]$n -le $lista.Count) { return $lista[[int]$n - 1] }
    Write-Host '  Numero invalido.' -ForegroundColor Yellow
  }
}
$crear = $true
if (Test-Path .env) {
  $r = Read-Host '[4/4] Ya existe .env. Reemplazarlo? (s/N)'
  if ($r -ne 's') { $crear = $false; Write-Host '[4/4] Se conserva el .env actual' -ForegroundColor Green }
}
if ($crear) {
  Write-Host '[4/4] Datos de conexion:'
  $amb = Read-Host '  Ambiente para la tarea programada (qa/prod) [qa]'
  if ($amb -ne 'prod') { $amb = 'qa' }
  $usuario = Read-Host '  Usuario CSHP'
  $pass = Leer-Secreto '  Contrasena CSHP'

  $impresoras = @(Get-CimInstance Win32_Printer | ForEach-Object { $_.Name })
  Write-Host ''
  Write-Host '  Impresoras de esta PC:'
  for ($i = 0; $i -lt $impresoras.Count; $i++) { Write-Host ("    {0}. {1}" -f ($i + 1), $impresoras[$i]) }
  $guia = Elegir-Impresora '  Numero de la impresora para GUIAS' $impresoras
  $diag = Elegir-Impresora '  Numero de la impresora para DIAGNOSTICOS' $impresoras

  $contenido = @"
AMBIENTE=$amb
CSHP_QA_URL=https://tallerqa.hpc.com.gt/CSHP
CSHP_PROD_URL=https://taller.hpc.com.gt/CSHP
CSHP_USUARIO=$usuario
CSHP_PASSWORD='$pass'
CSHP_CENTRO=HPCS016
CSHP_ESTADO_BUSCAR=106
CSHP_FILTRO_LLAMADA=LLS
CSHP_ESTADO_NUEVO=
IMPRESORA_GUIA=$guia
IMPRESORA_DIAGNOSTICO=$diag
ESPERA_IMPRESION_SEG=3
MAX_LLAMADAS=0
SOLO_LLAMADAS=
"@
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot '.env'), $contenido, (New-Object Text.UTF8Encoding $false))
  Write-Host "[4/4] .env creado (tarea programada: $amb)" -ForegroundColor Green
}

Write-Host ''
Write-Host 'Listo. Siguientes pasos (en esta carpeta):' -ForegroundColor Cyan
Write-Host '  npm.cmd run probar-impresoras   imprime 1 hoja de prueba en cada impresora'
Write-Host '  npm.cmd run listar              QA: solo lista las llamadas, no cambia nada'
Write-Host '  npm.cmd run qa                  QA: procesa e imprime viendo el navegador'
Write-Host '  programar-tarea.cmd             deja corriendo el robot cada 3 minutos'

# Envia un correo con el Outlook de escritorio de la sesion (sin Azure ni SMTP).
# Lo llama enviar-correos.mjs:  powershell -File outlook-enviar.ps1 -Archivo correo.json
# correo.json = { para:[...], cc:[...], asunto, html, de }   (de = cuenta de Outlook a usar, opcional)
param([Parameter(Mandatory = $true)][string]$Archivo)
$ErrorActionPreference = 'Stop'
try {
$c = Get-Content -LiteralPath $Archivo -Raw -Encoding UTF8 | ConvertFrom-Json
$o = New-Object -ComObject Outlook.Application
# Asegura que el perfil de Outlook este cargado (si Outlook estaba cerrado, COM lo abre sin sesion)
$ns = $o.GetNamespace('MAPI')
try { $ns.Logon('', '', $false, $false) } catch { }
$m = $o.CreateItem(0)
$m.To = (@($c.para) -join ';')
if ($c.cc) { $m.CC = (@($c.cc) -join ';') }
$m.Subject = $c.asunto
$m.HTMLBody = $c.html
if ($c.de) {
  $cuenta = $o.Session.Accounts | Where-Object { $_.SmtpAddress -eq $c.de } | Select-Object -First 1
  if (-not $cuenta) { throw "La cuenta $($c.de) no esta en este Outlook" }
  $m.SendUsingAccount = $cuenta
}
$m.Send()
Write-Output 'ENVIADO'
} catch {
  Write-Output "ERROR: $($_.Exception.Message)"
  exit 1
}

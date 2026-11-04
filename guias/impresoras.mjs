/**
 * Impresoras de Windows (vía PowerShell, sin dependencias extra).
 * Chromium con --kiosk-printing imprime en la impresora PREDETERMINADA de Windows,
 * así que antes de cada documento se cambia la predeterminada a la que le toca.
 */
import { execFileSync } from 'node:child_process'

const UTF8 = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; '

function ps(comando) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', UTF8 + comando],
    { encoding: 'utf8', windowsHide: true }).trim()
}

const comillas = (s) => `'${String(s).replace(/'/g, "''")}'`

export function listarImpresoras() {
  return ps('Get-CimInstance Win32_Printer | ForEach-Object { $_.Name }')
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

export function impresoraPredeterminada() {
  return ps("(Get-CimInstance Win32_Printer -Filter 'Default=TRUE').Name")
}

export function usarImpresora(nombre) {
  ps(`(New-Object -ComObject WScript.Network).SetDefaultPrinter(${comillas(nombre)})`)
  const actual = impresoraPredeterminada()
  if (actual !== nombre) throw new Error(`Windows no dejó "${nombre}" como predeterminada (quedó "${actual}")`)
}

/** Revisa que las impresoras del .env existan. Devuelve { guia, diagnostico } */
export function impresorasDelEnv() {
  const elegidas = {
    guia: (process.env.IMPRESORA_GUIA || '').trim(),
    diagnostico: (process.env.IMPRESORA_DIAGNOSTICO || '').trim(),
  }
  const hay = listarImpresoras()
  const faltan = Object.entries(elegidas).filter(([, n]) => !n || !hay.includes(n))
  if (faltan.length) {
    console.error('❌ Impresoras mal configuradas en .env:')
    for (const [doc, n] of faltan) console.error(`   ${doc === 'guia' ? 'IMPRESORA_GUIA' : 'IMPRESORA_DIAGNOSTICO'} = "${n}" (no existe)`)
    console.error('   Impresoras de esta PC:')
    hay.forEach((n) => console.error(`     ${n}`))
    console.error('   Corre setup.cmd otra vez o edita .env con:  notepad .env')
    process.exit(1)
  }
  return elegidas
}

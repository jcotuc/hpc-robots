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

// ─── Modo PDF (MODO_IMPRESION=pdf): imprimir sin navegador visible con SumatraPDF ───
// SumatraPDF portable (sin administrador) manda el PDF a una impresora POR NOMBRE:
// no hace falta cambiar la predeterminada de Windows ni tener un navegador por impresora.
import { execFile } from 'node:child_process'
import { existsSync as existe } from 'node:fs'
import { resolve } from 'node:path'

export const MODO_PDF = /^pdf$/i.test((process.env.MODO_IMPRESION || '').trim())

export function rutaSumatra() {
  const r = resolve((process.env.SUMATRA_PATH || 'bin/SumatraPDF.exe').trim())
  if (!existe(r)) {
    console.error(`❌ No está SumatraPDF en ${r}`)
    console.error('   Corre setup.cmd otra vez (lo descarga solo) o pon la ruta en .env:  SUMATRA_PATH=C:\\ruta\\SumatraPDF.exe')
    process.exit(1)
  }
  return r
}

/** Manda un archivo PDF a la impresora indicada. ajuste: fit | shrink | noscale (IMPRESION_AJUSTE del .env) */
export function imprimirPdf(archivo, impresora, ajuste = (process.env.IMPRESION_AJUSTE || 'fit').trim()) {
  const exe = rutaSumatra()
  return new Promise((ok, mal) => {
    execFile(exe, ['-print-to', impresora, '-print-settings', ajuste, '-silent', resolve(archivo)],
      { windowsHide: true, timeout: 90_000 }, (err) => {
        if (err) mal(new Error(`SumatraPDF no pudo imprimir en "${impresora}": ${err.killed ? 'tardó más de 90 s' : (err.code ?? err.message)}`))
        else ok()
      })
  })
}

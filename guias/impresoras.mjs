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

/** Papel predeterminado del controlador de la impresora, en pulgadas: { w, h, nombre } o null */
export function papelImpresora(nombre) {
  try {
    const r = ps(`Add-Type -AssemblyName System.Drawing; $s = New-Object System.Drawing.Printing.PrinterSettings; $s.PrinterName = ${comillas(nombre)}; $p = $s.DefaultPageSettings.PaperSize; "$($p.Width)|$($p.Height)|$($p.PaperName)"`)
    const [w, h, n] = r.split('|')
    if (!(Number(w) > 0 && Number(h) > 0)) return null
    return { w: Number(w) / 100, h: Number(h) / 100, nombre: n }
  } catch { return null }
}

// ─── Recorte de alto (la guía de CSHP mide 4.03 x 5 pulgadas y la etiqueta 4.1 x 4) ───
// Si el PDF es más alto que la etiqueta, la TSC lo reparte en dos etiquetas. El contenido de la
// guía está arriba (unas 3.5 pulgadas), así que se deja solo la parte de ARRIBA de ese alto.
// pdf-lib se carga solo en modo PDF (import dinámico): Zona 6 en modo navegador no lo necesita
const pdfLib = () => import('pdf-lib').then((m) => m.PDFDocument)
import { readFileSync as leer, writeFileSync as escribir } from 'node:fs'

/** Tamaño de la primera página en pulgadas: { w, h } o null */
export async function tamanoPdfIn(archivo) {
  try {
    const doc = await (await pdfLib()).load(leer(archivo), { ignoreEncryption: true })
    const { width, height } = doc.getPages()[0].getSize()
    return { w: width / 72, h: height / 72 }
  } catch { return null }
}

/** Devuelve la ruta de un PDF recortado a `altoIn` pulgadas (parte de arriba), o el mismo archivo si ya cabe */
export async function recortarAlto(archivo, altoIn) {
  if (!(altoIn > 0)) return archivo
  const doc = await (await pdfLib()).load(leer(archivo), { ignoreEncryption: true })
  const alto = altoIn * 72
  let cambio = false
  for (const p of doc.getPages()) {
    const { width, height } = p.getSize()
    if (height > alto + 1) { p.setMediaBox(0, height - alto, width, alto); p.setCropBox(0, height - alto, width, alto); cambio = true }
  }
  if (!cambio) return archivo
  const salida = archivo.replace(/\.pdf$/i, '') + '-etiqueta.pdf'
  escribir(salida, await doc.save())
  return salida
}

/** Alto de etiqueta para cada documento (.env). Guía: 4 pulgadas por defecto; diagnóstico: sin recorte */
export function altoEtiqueta(doc) {
  const v = process.env[doc === 'guia' ? 'IMPRESION_ALTO_GUIA' : 'IMPRESION_ALTO_DIAGNOSTICO']
  return v !== undefined && v.trim() !== '' ? Number(v) : (doc === 'guia' ? 4 : 0)
}

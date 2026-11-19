/**
 * Imprime un PDF en la impresora de guías o de diagnósticos, con el mismo ajuste que usa el robot.
 * Sirve para probar el tamaño con un PDF REAL de CSHP y para reimprimir a mano.
 *   npm.cmd run reimprimir -- guia C:\ruta\archivo.pdf
 *   npm.cmd run reimprimir -- diagnostico C:\ruta\archivo.pdf
 *   npm.cmd run reimprimir -- guia C:\ruta\archivo.pdf noscale     (probar otro ajuste: fit | shrink | noscale)
 */
import { readFileSync, existsSync } from 'node:fs'
import { impresorasDelEnv, imprimirPdf } from './impresoras.mjs'

const [doc = '', archivo = '', ajusteArg = ''] = process.argv.slice(2)
const tipo = /^g/i.test(doc) ? 'guia' : /^d/i.test(doc) ? 'diagnostico' : ''
if (!tipo || !archivo || !existsSync(archivo)) {
  console.error('Uso:  npm.cmd run reimprimir -- guia|diagnostico C:\\ruta\\archivo.pdf [fit|shrink|noscale]')
  process.exit(1)
}
const imp = impresorasDelEnv()[tipo]
const ajuste = (ajusteArg || process.env[tipo === 'guia' ? 'IMPRESION_AJUSTE_GUIA' : 'IMPRESION_AJUSTE_DIAGNOSTICO'] || process.env.IMPRESION_AJUSTE || 'fit').trim()

// Tamaño de la página del PDF (MediaBox, en puntos: 72 = 1 pulgada)
const txt = readFileSync(archivo).toString('latin1')
const m = txt.match(/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/)
if (m) {
  const w = (m[3] - m[1]) / 72, h = (m[4] - m[2]) / 72
  console.log(`Tamaño del PDF: ${w.toFixed(2)} x ${h.toFixed(2)} pulgadas (${(w * 2.54).toFixed(1)} x ${(h * 2.54).toFixed(1)} cm)`)
}
console.log(`Imprimiendo en ${imp} · ajuste ${ajuste}`)
await imprimirPdf(archivo, imp, ajuste)
console.log('Enviado.')

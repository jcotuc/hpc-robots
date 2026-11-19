/**
 * Imprime un PDF en la impresora de guías o de diagnósticos, con el mismo ajuste que usa el robot.
 * Sirve para probar el tamaño con un PDF REAL de CSHP y para reimprimir a mano.
 *   npm.cmd run reimprimir -- guia C:\ruta\archivo.pdf
 *   npm.cmd run reimprimir -- diagnostico C:\ruta\archivo.pdf
 *   npm.cmd run reimprimir -- guia C:\ruta\archivo.pdf noscale     (probar otro ajuste: fit | shrink | noscale)
 */
import { readFileSync, existsSync } from 'node:fs'
import { impresorasDelEnv, imprimirPdf, recortarAlto, altoEtiqueta, tamanoPdfIn } from './impresoras.mjs'

const [doc = '', archivo = '', ajusteArg = ''] = process.argv.slice(2)
const tipo = /^g/i.test(doc) ? 'guia' : /^d/i.test(doc) ? 'diagnostico' : ''
if (!tipo || !archivo || !existsSync(archivo)) {
  console.error('Uso:  npm.cmd run reimprimir -- guia|diagnostico C:\\ruta\\archivo.pdf [fit|shrink|noscale]')
  process.exit(1)
}
const imp = impresorasDelEnv()[tipo]
const ajuste = (ajusteArg || process.env[tipo === 'guia' ? 'IMPRESION_AJUSTE_GUIA' : 'IMPRESION_AJUSTE_DIAGNOSTICO'] || process.env.IMPRESION_AJUSTE || 'fit').trim()

const t = await tamanoPdfIn(archivo)
if (t) console.log(`Tamaño del PDF: ${t.w.toFixed(2)} x ${t.h.toFixed(2)} pulgadas (${(t.w * 2.54).toFixed(1)} x ${(t.h * 2.54).toFixed(1)} cm)`)
const alto = altoEtiqueta(tipo)
const aImprimir = await recortarAlto(archivo, alto)
if (aImprimir !== archivo) console.log(`Recortado a ${alto} pulgadas de alto (parte de arriba) para que quepa en una etiqueta`)
console.log(`Imprimiendo en ${imp} · ajuste ${ajuste}`)
await imprimirPdf(aImprimir, imp, ajuste)
console.log('Enviado.')

/**
 * Prueba que cada documento salga en su impresora, SIN tocar CSHP.
 * Igual que el robot: un navegador para guías y otro para diagnósticos.
 * Imprime 4 hojas: GUÍA 1, DIAGNÓSTICO 1, GUÍA 2, DIAGNÓSTICO 2 (la segunda ronda confirma
 * que cada navegador se queda con su impresora).
 * Uso:  npm.cmd run probar-impresoras
 */
import { chromium } from 'playwright'
import { impresorasDelEnv, impresoraPredeterminada, usarImpresora, MODO_PDF, imprimirPdf, rutaSumatra, papelImpresora } from './impresoras.mjs'
import { mkdirSync, readdirSync, statSync } from 'node:fs'

// Modo PDF: crea una hoja de prueba en PDF por impresora y la manda con SumatraPDF (sin navegador visible)
if (MODO_PDF) {
  const imp = impresorasDelEnv()
  console.log(`\nModo PDF · SumatraPDF: ${rutaSumatra()} · ajuste: ${process.env.IMPRESION_AJUSTE || 'fit'}\n`)
  mkdirSync('pdfs', { recursive: true })
  const b = await chromium.launch()
  const p = await b.newPage()
  try {
    for (const [doc, nombre] of Object.entries(imp)) {
      const titulo = doc === 'guia' ? 'GUÍA' : 'DIAGNÓSTICO'
      await p.setContent(`<h1 style="font:28px sans-serif">PRUEBA ${titulo}</h1><p style="font:16px sans-serif">Esta hoja debe salir en:<br><b>${nombre}</b></p>`)
      // Si ya hay un PDF REAL de CSHP de este documento (pdfs\\LLS...-guia.pdf), se usa ese: la hoja
      // de prueba es tamaño carta y en la etiqueta sale pequeña aunque el real salga bien
      const reales = readdirSync('pdfs').filter((f) => f.startsWith('LLS') && f.endsWith(`-${doc}.pdf`))
        .map((f) => ({ f: `pdfs/${f}`, t: statSync(`pdfs/${f}`).mtimeMs })).sort((x, y) => y.t - x.t)
      let archivo = reales[0]?.f
      // Sin PDF real: hoja de prueba del tamaño del papel configurado en la impresora (la etiqueta en la TSC)
      const papel = papelImpresora(nombre)
      if (!archivo) {
        archivo = `pdfs/prueba-${doc}.pdf`
        await p.pdf({ path: archivo, ...(papel ? { width: `${papel.w}in`, height: `${papel.h}in` } : { format: 'Letter' }) })
      }
      if (papel) console.log(`   Papel de ${nombre}: ${papel.nombre} · ${papel.w} x ${papel.h} pulgadas`)
      const ajuste = (process.env[doc === 'guia' ? 'IMPRESION_AJUSTE_GUIA' : 'IMPRESION_AJUSTE_DIAGNOSTICO'] || process.env.IMPRESION_AJUSTE || 'fit').trim()
      await imprimirPdf(archivo, nombre, ajuste)
      console.log(`🖨️  "${titulo}" → ${nombre} · ${reales[0] ? `PDF real ${archivo}` : 'hoja de prueba'} · ajuste ${ajuste}`)
    }
  } finally { await b.close() }
  console.log('\nRevisa: cada hoja dice en qué impresora debía salir. Si una salió mal o cortada, avisa.\n')
  process.exit(0)
}

const impresoras = impresorasDelEnv()
const original = impresoraPredeterminada()
console.log(`\nPredeterminada actual: ${original}`)

async function abrir(impresora) {
  usarImpresora(impresora)
  const b = await chromium.launch({ headless: false, args: ['--kiosk-printing'] })
  return { b, p: await b.newPage() }
}

async function hoja(page, titulo, impresora) {
  await page.setContent(`<h1 style="font:48px sans-serif">PRUEBA ${titulo}</h1>
    <p style="font:24px sans-serif">Esta hoja debe salir en:<br><b>${impresora}</b></p>`)
  usarImpresora(impresora)
  await page.evaluate(() => setTimeout(() => window.print(), 0))
  await page.waitForTimeout(6000)
  console.log(`🖨️  "${titulo}" → ${impresora}`)
}

const guia = await abrir(impresoras.guia)
const diag = await abrir(impresoras.diagnostico)
try {
  for (const ronda of [1, 2]) {
    await hoja(guia.p, `GUÍA ${ronda}`, impresoras.guia)
    await hoja(diag.p, `DIAGNÓSTICO ${ronda}`, impresoras.diagnostico)
  }
} finally {
  usarImpresora(original)
  await guia.b.close()
  await diag.b.close()
}
console.log(`\nPredeterminada restaurada: ${original}`)
console.log('Revisa: cada hoja dice en qué impresora debía salir (4 hojas). Si alguna salió en otra, NO programes la tarea.\n')

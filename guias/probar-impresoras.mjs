/**
 * Prueba que cada documento salga en su impresora, SIN tocar CSHP.
 * Igual que el robot: un navegador para guías y otro para diagnósticos.
 * Imprime 4 hojas: GUÍA 1, DIAGNÓSTICO 1, GUÍA 2, DIAGNÓSTICO 2 (la segunda ronda confirma
 * que cada navegador se queda con su impresora).
 * Uso:  npm.cmd run probar-impresoras
 */
import { chromium } from 'playwright'
import { impresorasDelEnv, impresoraPredeterminada, usarImpresora } from './impresoras.mjs'

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

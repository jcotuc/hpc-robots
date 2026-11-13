/**
 * Consulta existencias en Nodus (HH, ubicaciones CS y KB) — SOLO LECTURA. No mueve nada.
 *   npm.cmd run existencia -- 95781 18023 925207
 *   npm.cmd run existencia -- 95781 --visible
 * Usuario de HH: HH_USUARIO / HH_PASSWORD en .env (usuario de bodega)
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { loginHH, existencias } from '../shared/hh.mjs'

const args = process.argv.slice(2)
const QA = args.includes('--qa')
const BASE = ((QA ? process.env.CSHP_QA_URL : process.env.CSHP_PROD_URL) || (QA ? 'https://tallerqa.hpc.com.gt/CSHP' : 'https://taller.hpc.com.gt/CSHP')).replace(/\/(HH\/.*|Login\.aspx)?$/i, '')
const skus = args.filter((a) => /^\d+$/.test(a))
const USUARIO = process.env.HH_USUARIO, PASSWORD = process.env.HH_PASSWORD
if (!USUARIO || !PASSWORD) { console.error('❌ Falta HH_USUARIO / HH_PASSWORD en .env'); process.exit(1) }
if (!skus.length) { console.error('Uso: npm.cmd run existencia -- 95781 18023'); process.exit(1) }

const browser = await chromium.launch({ headless: !args.includes('--visible') })
const page = await (await browser.newContext()).newPage()
try {
  await loginHH(page, BASE, USUARIO, PASSWORD)
  console.log(`\n=== Existencias Nodus (CS/KB) · ${QA ? 'QA' : 'PRODUCCIÓN'} · usuario ${USUARIO.toUpperCase()} ===`)
  for (const sku of skus) {
    const r = await existencias(page, BASE, sku)
    console.log(`\n${sku}: ${r.total ? `${r.total} disponibles en Nodus` : 'SIN EXISTENCIA en Nodus'}`)
    for (const x of r.nodus) console.log(`   ${x.ubicacion.padEnd(16)} disp ${String(x.disponible).padStart(5)}  (exist ${x.existencia}, ${x.medida})`)
    const fuera = r.todas.filter((x) => !r.nodus.includes(x))
    if (fuera.length) console.log(`   (otras ubicaciones no Nodus o sin disponible: ${fuera.map((x) => `${x.ubicacion}=${x.disponible}`).join(', ')})`)
  }
} catch (e) {
  console.error(`❌ ${e.message || e}`)
  mkdirSync('capturas', { recursive: true })
  const ruta = `capturas/existencias-${Date.now()}.png`
  console.error(`   captura: ${ruta}`)
  await page.screenshot({ path: ruta, fullPage: true }).catch(() => {})
  process.exitCode = 1
} finally { await browser.close() }

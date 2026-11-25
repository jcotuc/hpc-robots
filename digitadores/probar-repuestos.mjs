/**
 * SOLO LECTURA: muestra cómo ve el robot los repuestos de cada llamada en CSHP producción.
 *   node --env-file=.env probar-repuestos.mjs LLS21-566914 LLS21-566832
 *   node --env-file=.env probar-repuestos.mjs --cola           (todas las de Garantía por digitar en la Bandeja)
 *   node --env-file=.env probar-repuestos.mjs --pendientes     (solo las que quedaron pendientes)
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { loginCSHP, abrirLlamadaCSHP, leerLlamadaCSHP } from '../shared/cshp-llamada.mjs'

const BASE = (process.env.CSHP_PROD_URL || 'https://taller.hpc.com.gt/CSHP').replace(/\/(Login\.aspx)?$/i, '')
const USUARIO = process.env.CSHP_PROD_USUARIO || process.env.CSHP_USUARIO
const PASSWORD = process.env.CSHP_PROD_PASSWORD || process.env.CSHP_PASSWORD
let nums = process.argv.slice(2).filter((n) => !n.startsWith('--')).map((n) => n.trim().toUpperCase()).filter(Boolean)
const motivos = {}
const COLA = process.argv.includes('--cola')
if (COLA || process.argv.includes('--pendientes')) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const est = await sb.from('llamadas_estados').select('id, nombre')
  const norm = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
  const idG = (est.data || []).find((e) => norm(e.nombre) === norm(process.env.ESTADO_BANDEJA || 'Garantía'))?.id
  let q = sb.from('llamadas_actualizaciones').select('num_llamada, pendiente_en, pendiente_motivo')
    .eq('estado_id', idG).is('digitado_en', null).is('garantia_id', null).order('created_at')
  if (!COLA) q = q.not('pendiente_en', 'is', null)
  const { data, error } = await q
  if (error) { console.error(error.message); process.exit(1) }
  for (const r of data) motivos[r.num_llamada.toUpperCase()] = r.pendiente_en ? `PENDIENTE: ${r.pendiente_motivo || 'sin motivo'}` : 'en cola (libre)'
  nums = [...new Set([...nums, ...Object.keys(motivos)])]
  console.log(`${nums.length} llamada(s) de Garantía ${COLA ? 'por digitar' : 'pendientes'} en la Bandeja`)
}
if (!nums.length) { console.error('Uso: node --env-file=.env probar-repuestos.mjs LLS21-123456 [...]'); process.exit(1) }

const browser = await chromium.launch()
const page = await browser.newPage()
try {
  await loginCSHP(page, BASE, USUARIO, PASSWORD)
  for (const n of nums) {
    try {
      await abrirLlamadaCSHP(page, BASE, n)
      const ll = await leerLlamadaCSHP(page)
      const v = (id) => page.locator(id).inputValue({ timeout: 2_000 }).catch(() => '')
      const status = (await page.locator('#FrmLLamadasServ_TxtStatus').first().textContent({ timeout: 2_000 }).catch(() => '')).trim()
      const reg = ll.registrados
      const veredicto = reg === null ? 'NO SE ENCONTRÓ LA TABLA → el robot exige factura'
        : reg.length === 0 ? 'SIN repuestos → no exige factura' : `CON ${reg.length} repuesto(s) → exige factura`
      console.log(`\n${n} · status ${status || '?'} · Caja ${await v('#FrmLLamadasServ_TxtCaja') || '-'} · Transacción ${await v('#FrmLLamadasServ_TxtTransaccion') || '-'}`)
      console.log(`   Repuestos Registrados: ${reg === null ? 'tabla no encontrada' : reg.length}`)
      for (const r of reg || []) console.log(`      ${r.SKU} × ${r['Cant.']} · ${r.Origen} → ${r.Destino}`)
      console.log(`   Repuestos Solicitados: ${ll.solicitados === null ? 'tabla no encontrada' : ll.solicitados.length}`)
      if (motivos[n]) console.log(`   Bandeja: ${motivos[n].slice(0, 160)}`)
      console.log(`   ⇒ ${veredicto}`)
    } catch (e) { console.log(`\n${n} · ERROR ${String(e.message).split('\n')[0]}`) }
  }
} finally { await browser.close() }

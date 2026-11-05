/**
 * Consulta SOLO LECTURA de llamadas en CSHP producción: no modifica nada.
 * Abre cada llamada y guarda sus datos (cliente, status, tipología, opciones marcadas, guías e historial)
 * en logs\consulta.txt para revisarlos.
 *   node --env-file=.env consultar.mjs LLM21-315742 LLM21-317302 ...
 */
import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'node:fs'

const BASE = (process.env.CSHP_PROD_URL || 'https://taller.hpc.com.gt/CSHP').replace(/\/(Login\.aspx)?$/i, '')
const USUARIO = process.env.CSHP_PROD_USUARIO || process.env.CSHP_USUARIO
const PASSWORD = process.env.CSHP_PROD_PASSWORD || process.env.CSHP_PASSWORD
const nums = process.argv.slice(2).map((n) => n.trim().toUpperCase()).filter(Boolean)
if (!nums.length) { console.error('Uso: node --env-file=.env consultar.mjs LLM21-123456 [...]'); process.exit(1) }

async function esperar(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await page.waitForFunction(() => { const p = window.Sys?.WebForms?.PageRequestManager?.getInstance?.(); return !p || !p.get_isInAsyncPostBack() }, null, { timeout: 20_000 }).catch(() => {})
  await page.waitForTimeout(800)
}

const browser = await chromium.launch()
const page = await (await browser.newContext()).newPage()
await page.goto(`${BASE}/Login.aspx`)
await page.locator('#FrmAcceso1_TxtUsuario').fill(USUARIO)
await page.locator('#FrmAcceso1_TxtPassword').fill(PASSWORD)
await page.getByRole('button', { name: 'Submit', exact: true }).click()
await esperar(page)

const salida = []
for (const n of nums) {
  try {
    await page.goto(`${BASE}/LLamadasServ.aspx`); await esperar(page)
    await page.locator('#FrmLLamadasServ_TxtFLlamada').fill(n)
    await page.locator('#FrmLLamadasServ_CmdBuscar').click(); await esperar(page)
    const fila = await page.locator('tr').filter({ hasNot: page.locator('tr') }).filter({ hasText: n }).first().innerText().catch(() => '')
    await page.getByRole('link', { name: n, exact: true }).first().click(); await esperar(page)
    await page.waitForTimeout(1500)
    const datos = await page.evaluate(() => {
      const visibles = [...document.querySelectorAll('input, textarea, select, span[id]')].filter((e) => e.offsetParent !== null && !/TxtF|CmbF|LblF|Orden|Header|Titulo/.test(e.id))
      const campos = visibles.map((e) => {
        if (e.type === 'radio' || e.type === 'checkbox') return `${e.id} [${e.checked ? 'X' : ' '}] ${e.nextSibling?.textContent?.trim() || ''}`
        const v = e.tagName === 'SELECT' ? e.options[e.selectedIndex]?.text : (e.value ?? e.textContent)
        return v && String(v).trim() && !/^(submit|button|image)$/i.test(e.type) ? `${e.id} = ${String(v).trim().replace(/\s+/g, ' ').slice(0, 200)}` : null
      }).filter(Boolean)
      const log = [...document.querySelectorAll('tr')].filter((t) => !t.querySelector('tr') && /Cambio Status|Registro|Comentario/i.test(t.textContent)).map((t) => t.innerText.replace(/\s+/g, ' ').trim())
      return { campos, log }
    })
    salida.push(`===== ${n}\nLISTA: ${fila.replace(/\s+/g, ' ')}\n-- CAMPOS\n${datos.campos.join('\n')}\n-- HISTORIAL\n${datos.log.join('\n')}\n`)
    console.log(`✔ ${n}`)
  } catch (e) { salida.push(`===== ${n}\nERROR ${e.message}\n`); console.log(`✖ ${n}: ${e.message}`) }
}
await browser.close()
mkdirSync('logs', { recursive: true })
writeFileSync('logs/consulta.txt', salida.join('\n'))
console.log('Listo: logs\\consulta.txt')

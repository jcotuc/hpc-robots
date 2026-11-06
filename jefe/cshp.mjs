/**
 * Lectura de CSHP por la web para el Jefe — SOLO LEE: nunca presiona Modificar, Cambiar Status ni Aceptar.
 * Mismos pasos que usa Digitadores para abrir una llamada.
 */
// playwright se carga solo cuando hace falta abrir CSHP

const normalizar = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

export async function abrirCSHP({ base, usuario, password, visible = false }) {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: !visible })
  const page = await (await browser.newContext()).newPage()
  page.setDefaultTimeout(30_000)
  page.on('dialog', (d) => d.dismiss().catch(() => {}))   // el Jefe no acepta nada
  const cshp = { browser, page, base, usuario, password }
  await login(cshp)
  return cshp
}
export async function cerrarCSHP(cshp) { await cshp?.browser?.close().catch(() => {}) }

async function esperar(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 1_500 }).catch(() => {})
  await page.waitForFunction(() => {
    const prm = window.Sys?.WebForms?.PageRequestManager?.getInstance?.()
    return !prm || !prm.get_isInAsyncPostBack()
  }, null, { timeout: 20_000 }).catch(() => {})
  await page.waitForTimeout(300)
}
async function login({ page, base, usuario, password }) {
  for (let i = 1; i <= 2; i++) {
    await page.goto(`${base}/Login.aspx`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.locator('#FrmAcceso1_TxtUsuario').waitFor({ state: 'visible', timeout: 20_000 })
    await page.locator('#FrmAcceso1_TxtUsuario').fill(usuario)
    await page.locator('#FrmAcceso1_TxtPassword').fill(password)
    await page.getByRole('button', { name: 'Submit', exact: true }).click().catch(() => page.locator('#FrmAcceso1_TxtPassword').press('Enter'))
    await page.waitForURL((u) => !/Login/i.test(u.pathname), { timeout: 15_000 }).catch(() => {})
    await esperar(page)
    if (!/Login|BloqSeguridad/i.test(page.url())) return
    await page.waitForTimeout(2_000)
  }
  throw new Error(`CSHP no aceptó el inicio de sesión de ${usuario}`)
}

const filasLog = (page) => page.locator('tr').filter({ hasNot: page.locator('tr') }).filter({ hasText: 'Cambio Status' })

/** Abre una llamada (solo lectura) y devuelve lo que el Jefe necesita revisar */
export async function leerLlamada(cshp, numero) {
  const { page, base } = cshp
  await page.goto(`${base}/LLamadasServ.aspx`, { waitUntil: 'domcontentloaded' })
  if (/Login|BloqSeguridad/i.test(page.url())) { await login(cshp); await page.goto(`${base}/LLamadasServ.aspx`, { waitUntil: 'domcontentloaded' }) }
  await esperar(page)
  const link = page.getByRole('link', { name: numero, exact: true })
  for (let i = 1; i <= 2; i++) {
    await page.locator('#FrmLLamadasServ_TxtFLlamada').fill(numero)
    await page.locator('#FrmLLamadasServ_CmdBuscar').click({ timeout: 5_000 }).catch(() => page.evaluate(() => document.querySelector('#FrmLLamadasServ_CmdBuscar')?.click()))
    await esperar(page)
    if (await link.first().waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false)) break
  }
  const n = await link.count()
  if (n !== 1) throw new Error(n ? `Aparece ${n} veces ${numero} en CSHP` : `No se encontró ${numero} en CSHP`)
  await link.click()
  await esperar(page)
  const limite = Date.now() + 30_000
  while ((await filasLog(page).count().catch(() => 0)) === 0 && !(await page.locator('#FrmLLamadasServ_CmdCambiarStatus').isVisible().catch(() => false))) {
    if (Date.now() > limite) throw new Error(`CSHP no terminó de abrir ${numero}`)
    await page.waitForTimeout(500)
  }
  await esperar(page)
  const val = (sel) => page.locator(sel).inputValue({ timeout: 3_000 }).then((v) => v.trim()).catch(() => '')
  const filas = await filasLog(page).evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => (td.textContent || '').replace(/\s+/g, ' ').trim())))
  const statusLog = filas.map((f) => f[2] || '')
  // fila del log donde pasó a Logística (texto completo: fecha, usuario, observaciones)
  const filaLogistica = filas.find((f) => /log[ií]stica/i.test(f[2] || '') || /logistica/i.test(normalizar(f[2] || '')))
  return {
    numero,
    cliente: await val('#FrmLLamadasServ_TxtNombre'),
    comentario: await val('#FrmLLamadasServ_TxtComentario'),
    guiaRecep: await val('#FrmLLamadasServ_TxtGuiaRecep'),
    sku: await val('#FrmLLamadasServ_TxtSKU'),
    statusActual: statusLog[0] || '',
    pasoPorLogistica: statusLog.some((s) => /log[ií]stica/i.test(normalizar(s).replace('logistica', 'logística')) || /logistica/i.test(normalizar(s))),
    statusLog,
    logistica: filaLogistica ? filaLogistica.filter(Boolean).join(' · ').slice(0, 200) : '',
  }
}

/** ¿Responde CSHP? (página de login, sin iniciar sesión) */
export async function cshpResponde(base) {
  const t0 = Date.now()
  try {
    const r = await fetch(`${base}/Login.aspx`, { signal: AbortSignal.timeout(20_000) })
    return { ok: r.ok, ms: Date.now() - t0, detalle: r.ok ? '' : `HTTP ${r.status}` }
  } catch (e) { return { ok: false, ms: Date.now() - t0, detalle: String(e.cause?.code || e.message) } }
}

/** Llamadas que Guías tiene por imprimir: lista de CSHP filtrada por centro y status (solo lectura) */
export async function pendientesGuias(cshp, { centro = 'HPCS016', status = '106', filtro = 'LLS' } = {}) {
  const { page, base } = cshp
  await page.goto(`${base}/LLamadasServ.aspx`, { waitUntil: 'domcontentloaded' })
  if (/Login|BloqSeguridad/i.test(page.url())) { await login(cshp); await page.goto(`${base}/LLamadasServ.aspx`, { waitUntil: 'domcontentloaded' }) }
  await esperar(page)
  const elegir = async (sel, buscado) => {
    const combo = page.locator(sel); await combo.waitFor({ state: 'visible', timeout: 15_000 })
    const ops = await combo.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: (o.textContent || '').trim() })))
    const b = buscado.toLowerCase()
    const op = ops.find((o) => o.v.toLowerCase() === b) || ops.find((o) => o.t.toLowerCase() === b) || ops.find((o) => o.v && (o.t.toLowerCase().includes(b) || o.v.toLowerCase().includes(b)))
    if (!op) throw new Error(`No existe "${buscado}" en ${sel}`)
    await combo.selectOption(op.v); await esperar(page)
  }
  await elegir('#FrmLLamadasServ_CmbFCentro', centro)
  await elegir('#FrmLLamadasServ_CmbFStatus', status)
  await page.locator('#FrmLLamadasServ_TxtFLlamada').fill(filtro)
  await page.locator('#FrmLLamadasServ_CmdBuscar').click({ timeout: 5_000 }).catch(() => page.evaluate(() => document.querySelector('#FrmLLamadasServ_CmdBuscar')?.click()))
  await esperar(page)
  await page.waitForTimeout(1_500)
  const textos = await page.getByRole('link', { name: /^LLS\d+-\d+$/i }).allTextContents()
  return [...new Set(textos.map((t) => t.trim().toUpperCase()))]
}

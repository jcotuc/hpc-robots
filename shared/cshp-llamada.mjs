// cshp-llamada.mjs — leer una llamada de CSHP (SOLO LECTURA): número SAP, técnico,
// "Repuestos Solicitados" y "Repuestos Registrados". Lo usan despacho-repuestos y el auditor.

async function esperar(page, ms = 300) {
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 1_500 }).catch(() => {})
  await page.waitForFunction(() => {
    const prm = window.Sys?.WebForms?.PageRequestManager?.getInstance?.()
    return !prm || !prm.get_isInAsyncPostBack()
  }, null, { timeout: 20_000 }).catch(() => {})
  await page.waitForTimeout(ms)
}

export async function loginCSHP(page, base, usuario, password) {
  for (let i = 1; i <= 3; i++) {
    await page.goto(`${base}/Login.aspx`, { waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.locator('#FrmAcceso1_TxtUsuario').waitFor({ state: 'visible', timeout: 15_000 })
    await page.locator('#FrmAcceso1_TxtUsuario').fill(String(usuario).trim())
    await page.locator('#FrmAcceso1_TxtPassword').fill(String(password).trim())
    await page.locator('#FrmAcceso1_TxtPassword').press('Enter')
    await page.waitForURL((u) => !/Login/i.test(u.pathname), { timeout: 10_000 }).catch(() => {})
    await esperar(page)
    if (!/Login|BloqSeguridad/i.test(page.url())) return
    await page.waitForTimeout(2_000)
  }
  throw new Error(`No se pudo iniciar sesión en CSHP con ${usuario}`)
}

export async function abrirLlamadaCSHP(page, base, numero) {
  await page.goto(`${base}/LLamadasServ.aspx`, { waitUntil: 'domcontentloaded' })
  await esperar(page)
  const link = page.getByRole('link', { name: numero, exact: true })
  for (let i = 1; i <= 2; i++) {
    await page.locator('#FrmLLamadasServ_TxtFLlamada').fill(numero)
    await page.locator('#FrmLLamadasServ_CmdBuscar').click()
    await esperar(page)
    if (await link.first().waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false)) break
  }
  const n = await link.count()
  if (n !== 1) throw new Error(n ? `Aparece ${n} veces ${numero} en la lista` : `No se encontró ${numero} en CSHP`)
  await link.click()
  await esperar(page)
  await page.locator('#FrmLLamadasServ_TxtDocSAP, #FrmLLamadasServ_TxtTecnico').first().waitFor({ timeout: 30_000 })
}

/** Tabla cuyo encabezado contiene todas las columnas indicadas → arreglo de objetos {columna: valor} */
async function tabla(page, columnas) {
  return page.evaluate((cols) => {
    const txt = (c) => c.textContent.replace(/\s+/g, ' ').trim()
    for (const t of document.querySelectorAll('table')) {
      if (t.offsetParent === null) continue
      const filas = [...t.querySelectorAll(':scope > tbody > tr, :scope > tr, :scope > thead > tr')].map((tr) => [...tr.children].map(txt))
      const i = filas.findIndex((f) => cols.every((c) => f.includes(c)))
      if (i < 0) continue
      const enc = filas[i]
      return filas.slice(i + 1).filter((f) => /^\d+$/.test(f[enc.indexOf('SKU')] || ''))
        .map((f) => Object.fromEntries(enc.map((c, j) => [c || `col${j}`, f[j] ?? ''])))
    }
    return null
  }, columnas).catch(() => null)
}

const valor = (page, sel) => page.locator(sel).first().evaluate((e) => (('value' in e && e.tagName !== 'SPAN') ? e.value : e.textContent) ?? '').then((v) => String(v).trim()).catch(() => '')

/** Lee la llamada abierta: SAP, técnico, solicitados y registrados */
export async function leerLlamadaCSHP(page) {
  return {
    sap: (await valor(page, '#FrmLLamadasServ_TxtDocSAP')) || null,
    tecnico: await valor(page, '#FrmLLamadasServ_TxtTecnico'),
    solicitados: await tabla(page, ['SKU', 'Solicitado', 'Despachado']),
    registrados: await tabla(page, ['SKU', 'Cant.', 'Origen', 'Destino']),
  }
}

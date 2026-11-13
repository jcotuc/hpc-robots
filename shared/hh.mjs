// hh.mjs — CSHP HH (handheld de bodega): login, "Respuestos Llamada" y consulta de existencias por SKU.
// Lo usan solicitud-repuestos (validar existencia) y despacho-repuestos.
// Grabación 2026-11-11: HH.aspx → login → "- Respuestos Llamada" → #HHFrmRepuestosLLS1_TxtSKU + Enter
//   → tabla  Ubic. | Cant. | Medida | Exist. | Disp.
// Nodus: solo cuentan las ubicaciones que empiezan con CS o KB.

export const UBIC_NODUS = /^(CS|KB)/i

async function esperar(page, ms = 300) {
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => {})
  await page.waitForTimeout(ms)
}

/** base = https://taller.hpc.com.gt/CSHP  (o tallerqa) */
export async function loginHH(page, base, usuario, password) {
  const menu = () => page.getByRole('link', { name: /Respuestos Llamada/i }).first().isVisible().catch(() => false)
  let detalle = ''
  for (let intento = 1; intento <= 3; intento++) {
    await page.goto(`${base}/HH/HH.aspx`, { waitUntil: 'domcontentloaded' }).catch(() => {})
    await esperar(page, 500)
    if (await menu()) return
    const u = page.locator('#HHFrmAcceso1_TxtUsuario')
    await u.waitFor({ state: 'visible', timeout: 15_000 })
    await u.fill(String(usuario).trim().toUpperCase())
    await page.locator('#HHFrmAcceso1_TxtPassword').fill(String(password).trim())
    // Como en la grabación: botón Submit; si no está, Enter en la contraseña
    const btn = page.getByRole('button', { name: 'Submit', exact: true })
    if (await btn.isVisible().catch(() => false)) await btn.click()
    else await page.locator('#HHFrmAcceso1_TxtPassword').press('Enter')
    await esperar(page, 1_500)
    for (let i = 0; i < 10 && !(await menu()); i++) await page.waitForTimeout(500)
    if (await menu()) return
    // Texto visible tras el intento (mensaje de usuario/clave incorrecta, bloqueo, etc.)
    detalle = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300)
    await page.waitForTimeout(2_000)
  }
  throw new Error(`No se pudo iniciar sesión en HH con ${String(usuario).toUpperCase()} en ${base}. Pantalla: "${detalle}"`)
}

/** Entra a "- Respuestos Llamada" (pantalla con los campos de llamada y de SKU) */
export async function abrirRepuestosLlamada(page, base) {
  const sku = page.locator('#HHFrmRepuestosLLS1_TxtSKU')
  if (await sku.isVisible().catch(() => false)) return
  const link = page.getByRole('link', { name: /Respuestos Llamada/i })
  if (await link.isVisible().catch(() => false)) await link.click()
  else await page.goto(`${base}/HH/HHRepuestosLLS.aspx`, { waitUntil: 'domcontentloaded' })
  await esperar(page)
  await sku.waitFor({ state: 'visible', timeout: 15_000 })
}

/** Lee la tabla de existencias (encabezado con "Ubic." y "Disp.") */
async function leerTabla(page) {
  return page.evaluate(() => {
    const txt = (c) => c.textContent.replace(/\s+/g, ' ').trim()
    for (const t of document.querySelectorAll('table')) {
      if (t.offsetParent === null) continue
      const filas = [...t.querySelectorAll('tr')].map((tr) => [...tr.children].map(txt))
      const i = filas.findIndex((f) => f.some((c) => /^Ubic/i.test(c)) && f.some((c) => /^Disp/i.test(c)))
      if (i < 0) continue
      const enc = filas[i]
      const col = (re) => enc.findIndex((c) => re.test(c))
      const [cU, cC, cM, cE, cD] = [/^Ubic/i, /^Cant/i, /^Medida/i, /^Exist/i, /^Disp/i].map(col)
      return filas.slice(i + 1).filter((f) => f[cU]).map((f) => ({
        ubicacion: f[cU].toUpperCase(), cantidad: Number(f[cC]) || 0, medida: f[cM] || '',
        existencia: Number(f[cE]) || 0, disponible: Number(f[cD]) || 0,
      }))
    }
    return []
  }).catch(() => [])
}

/**
 * Existencias de un SKU en HH. Devuelve { sku, nodus: [...CS/KB con disponible], todas: [...], total }
 * (ordenadas: KB primero, luego CS; dentro, mayor disponible primero)
 */
export async function existencias(page, base, sku) {
  await abrirRepuestosLlamada(page, base)
  const campo = page.locator('#HHFrmRepuestosLLS1_TxtSKU')
  const antes = JSON.stringify(await leerTabla(page))
  await campo.fill(String(sku).trim())
  await campo.press('Enter')
  await esperar(page)
  // espera a que la tabla cambie (o hasta 10 s: puede que el SKU no tenga existencias)
  const limite = Date.now() + 10_000
  let todas = await leerTabla(page)
  while (JSON.stringify(todas) === antes && Date.now() < limite) { await page.waitForTimeout(400); todas = await leerTabla(page) }
  const nodus = todas.filter((r) => UBIC_NODUS.test(r.ubicacion) && r.disponible > 0)
    .sort((a, b) => (a.ubicacion.slice(0, 2) === b.ubicacion.slice(0, 2) ? b.disponible - a.disponible : /^KB/i.test(a.ubicacion) ? -1 : 1))
  return { sku: String(sku).trim(), nodus, todas, total: nodus.reduce((s, r) => s + r.disponible, 0) }
}

// ─── Despacho ("Respuestos Llamada" por número SAP) ────────────────────────
// Grabación 2026-11-10: #HHFrmRepuestosLLS1_TxtCodigo = número SAP + Enter → un repuesto por pantalla:
//   #HHFrmRepuestosLLS1_TxtUbicacion (origen) + #HHFrmRepuestosLLS1_TxtCantidad + Submit → siguiente.
//   El destino (ubicación del técnico) ya viene cargado.

/** Escribe el número SAP de la llamada y Enter */
export async function abrirLlamadaHH(page, base, sap) {
  await abrirRepuestosLlamada(page, base)
  const c = page.locator('#HHFrmRepuestosLLS1_TxtCodigo')
  await c.waitFor({ state: 'visible', timeout: 15_000 })
  await c.fill(String(sap).trim())
  await c.press('Enter')
  await esperar(page, 800)
}

/** Pantalla "Repuestos de Llamada de Servicio" (confirmada en producción 2026-11-11):
 *  TxtCodigo (la llamada; HH la cambia al número SAP) · OpModo A=Agregar / Q=Quitar · TxtTecnico (destino)
 *  TxtSKU (repuesto actual, editable: Enter cambia de repuesto) · TxtNomSKU · TxtSolicitado
 *  TxtCantidad · TxtUbicacion (origen) · CmdAceptar · GridExistencia (Ubic. Cant. Medida Exist. Disp.) */
export async function leerPantallaHH(page) {
  return page.evaluate(() => {
    const P = 'HHFrmRepuestosLLS1_'
    const el = (id) => document.getElementById(P + id)
    const v = (id) => { const e = el(id); return e ? String(('value' in e && e.tagName !== 'SPAN') ? e.value : e.textContent || '').replace(/\s+/g, ' ').trim() : '' }
    const visible = (id) => { const e = el(id); return !!e && e.offsetParent !== null }
    const campos = [...document.querySelectorAll(`[id^="${P}"]`)].filter((e) => !/^(Pan|Grid)/.test(e.id.replace(P, '')))
      .map((e) => ({ id: e.id.replace(P, ''), valor: v(e.id.replace(P, '')), visible: e.offsetParent !== null }))
    const mensajes = campos.filter((c) => c.visible && /lbl.*(err|msg|mens|aviso|info)|error|mensaje/i.test(c.id) && c.valor).map((c) => c.valor)
    const grid = el('GridExistencia')
    const sugeridas = grid ? [...grid.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => c.textContent.trim()))
      .filter((f) => f.length >= 5 && !/^Ubic/i.test(f[0]))
      .map((f) => ({ ubicacion: f[0].toUpperCase(), cantidad: Number(f[1]) || 0, medida: f[2], existencia: Number(f[3]) || 0, disponible: Number(f[4]) || 0 })) : []
    const modo = document.querySelector(`#${P}OpModo_0:checked`) ? 'A' : document.querySelector(`#${P}OpModo_1:checked`) ? 'Q' : ''
    return {
      llamada: v('TxtCodigo'), tecnico: v('TxtTecnico'), sku: v('TxtSKU'), nombre: v('TxtNomSKU'),
      solicitado: Number(v('TxtSolicitado')) || 0, cantidad: v('TxtCantidad'), modo,
      pideUbicacion: visible('TxtUbicacion') && visible('CmdAceptar'),
      sugeridas, mensajes, campos, texto: document.body.innerText.replace(/[ \t]+/g, ' '),
    }
  })
}

/** ¿Se puede escribir otro SKU en la pantalla? (con la llamada cargada HH puede dejarlo bloqueado) */
export async function skuEditableHH(page) {
  return page.locator('#HHFrmRepuestosLLS1_TxtSKU').isEditable({ timeout: 2_000 }).catch(() => false)
}

/** Lleva la pantalla al repuesto indicado. Si ya está en él no toca nada; si el campo SKU está bloqueado
 *  y es otro repuesto, devuelve la pantalla tal cual (quien llama decide) */
export async function irARepuestoHH(page, sku) {
  const actual = await leerPantallaHH(page)
  const igual = (x) => String(x).trim().replace(/^0+/, '') === String(sku).trim().replace(/^0+/, '')
  if (igual(actual.sku)) return actual
  if (!(await skuEditableHH(page))) return actual
  const c = page.locator('#HHFrmRepuestosLLS1_TxtSKU')
  await c.fill(String(sku).trim(), { timeout: 10_000 })
  await c.press('Enter')
  await esperar(page, 800)
  return leerPantallaHH(page)
}

/** Modo Agregar + cantidad + ubicación de origen + Aceptar. Devuelve avisos (alert) si salen */
export async function despacharPantalla(page, ubicacion, cantidad) {
  const avisos = []
  const alDialogo = (d) => { avisos.push(d.message()); d.accept().catch(() => {}) }
  page.on('dialog', alDialogo)
  try {
    const a = page.locator('#HHFrmRepuestosLLS1_OpModo_0')
    if (!(await a.isChecked().catch(() => true))) { await a.check(); await esperar(page) }
    await page.locator('#HHFrmRepuestosLLS1_TxtCantidad').fill(String(cantidad))
    await page.locator('#HHFrmRepuestosLLS1_TxtUbicacion').fill(String(ubicacion).trim())
    await page.locator('#HHFrmRepuestosLLS1_CmdAceptar').click()
    await esperar(page, 1_000)
  } finally { page.off('dialog', alDialogo) }
  return avisos
}

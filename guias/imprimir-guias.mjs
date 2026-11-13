/**
 * Guías y diagnósticos → CSHP
 *
 * Busca las llamadas del centro y status configurados (por defecto HPCS016 / 106) y por cada una:
 *   1. Abre la llamada
 *   2. Cambiar Status → Aceptar
 *   3. Guía de envío → Imprimir  (en IMPRESORA_GUIA)
 *   4. Diagnóstico   → Imprimir  (en IMPRESORA_DIAGNOSTICO)
 *   5. Aceptar → regresa a la lista y vuelve a buscar (así recorre todas, aunque haya varias páginas)
 *
 * Si una llamada ya cambió de status y algo falla después, la corrida SE DETIENE y la llamada queda
 * anotada en registro.json para revisarla a mano. Nunca se vuelve a procesar sola.
 *
 * Uso:  npm.cmd run listar   QA, solo lista las llamadas (no cambia ni imprime nada)
 *       npm.cmd run probar-visor  QA, revisa que el diagnóstico se pueda imprimir en su navegador
 *       npm.cmd run qa       QA, procesa e imprime
 *       npm.cmd run prod     producción
 *       correr.cmd           lo usa la tarea programada (ambiente según AMBIENTE del .env)
 */
import { chromium } from 'playwright'
import { mkdirSync, openSync, writeSync, closeSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, statSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { impresorasDelEnv, impresoraPredeterminada, usarImpresora } from './impresoras.mjs'
import { crearMonitor } from '../shared/monitor.mjs'
import { salirSiKardex } from '../shared/kardex-pausa.mjs'
await salirSiKardex('guias')   // pausa mientras Kardex actualiza inventario en esta PC

// ─── Configuración ───────────────────────────────────────────────────────────
const PROD = process.argv.includes('--prod') || (!process.argv.includes('--qa') && /^prod/i.test(process.env.AMBIENTE || ''))
const BASE = ((PROD ? process.env.CSHP_PROD_URL : process.env.CSHP_QA_URL)
  || (PROD ? 'https://taller.hpc.com.gt/CSHP' : 'https://tallerqa.hpc.com.gt/CSHP')).replace(/\/(Login\.aspx)?$/i, '')
const USUARIO = (PROD && process.env.CSHP_PROD_USUARIO) || process.env.CSHP_USUARIO
const PASSWORD = (PROD && process.env.CSHP_PROD_PASSWORD) || process.env.CSHP_PASSWORD
const CENTRO = (process.env.CSHP_CENTRO || 'HPCS016').trim()
const ESTADO_BUSCAR = (process.env.CSHP_ESTADO_BUSCAR || '106').trim()
// Vacío = deja el status que CSHP propone en "Nuevo Status" (igual que la grabación)
const ESTADO_NUEVO = (process.env.CSHP_ESTADO_NUEVO || '').trim()
const ESPERA_IMPRESION = Number(process.env.ESPERA_IMPRESION_SEG || 3) * 1000
// 0 = sin límite: sigue hasta que la lista quede vacía
const MAX = Number(process.env.MAX_LLAMADAS ?? 0) || Infinity
// Texto que se escribe en el campo Llamada para filtrar (LLS = solo llamadas de servicio, no LLM)
const FILTRO = (process.env.CSHP_FILTRO_LLAMADA ?? 'LLS').trim()
const SOLO = String(process.env.SOLO_LLAMADAS || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)
const SOLO_LISTAR = process.argv.includes('--solo-listar')
const PROBAR_VISOR = process.argv.includes('--probar-visor')
const LENTO = process.argv.includes('--lento')
const ES_PROD = !/tallerqa/i.test(BASE)
const PATRON = /^LLS\d+-\d+$/i
const REGISTRO = 'registro.json'
const mon = crearMonitor('guias', { intervaloSeg: 180, activo: ES_PROD && !SOLO_LISTAR && !PROBAR_VISOR })

const malas = SOLO.filter((n) => !PATRON.test(n))
if (malas.length) {
  console.error(`❌ SOLO_LLAMADAS tiene valores que no son número de llamada: ${malas.join(', ')}`)
  console.error('   Usa el número completo (ej. SOLO_LLAMADAS=LLS21-550699) o déjalo vacío para procesar todas:  notepad .env')
  process.exit(1)
}
for (const [k, v] of Object.entries({ CSHP_USUARIO: USUARIO, CSHP_PASSWORD: PASSWORD })) {
  if (!v) { console.error(`❌ Falta ${k} en .env`); process.exit(1) }
}

// ─── Registro local: qué pasos se hicieron en cada llamada ───────────────────
const ahora = () => new Date().toISOString()
let registro = {}
try { registro = JSON.parse(readFileSync(REGISTRO, 'utf8')) } catch { /* primera vez */ }
const guardarRegistro = () => writeFileSync(REGISTRO, JSON.stringify(registro, null, 2))

function anotar(numero, paso, extra = {}) {
  const r = (registro[numero] ||= { ambiente: ES_PROD ? 'prod' : 'qa', inicio: ahora(), pasos: [] })
  r.pasos.push({ paso, hora: ahora(), ...extra })
  Object.assign(r, extra.estado ? { estado: extra.estado } : {})
  guardarRegistro()
}
// ─── Resumen legible: logs\\resumen-AAAA-MM-DD.log (una línea por llamada) ─────
const horaGT = () => new Date().toLocaleTimeString('es-GT', { timeZone: 'America/Guatemala', hour12: false })
const fechaGT = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' })
function resumen(linea) {
  mon.linea(linea)
  try {
    mkdirSync('logs', { recursive: true })
    appendFileSync(`logs/resumen-${fechaGT()}.log`, `${horaGT()}  ${linea}\r\n`)
  } catch { /* el resumen nunca detiene el robot */ }
}

const yaCambioStatus = (n) => registro[n]?.pasos?.some((p) => p.paso === 'status')
const pendienteRevision = (n) => registro[n] && registro[n].estado !== 'completa' && yaCambioStatus(n)

// ─── Utilidades CSHP (mismas que MiMO / citas) ───────────────────────────────
async function clic(page, selector) {
  try { await page.locator(selector).click({ timeout: 5_000 }) }
  catch { await page.evaluate((s) => document.querySelector(s)?.click(), selector) }
}

async function esperarCSHP(page) {
  // CSHP casi nunca queda 100 % quieto en la red: lo que manda es que ASP.NET termine el postback
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 1_500 }).catch(() => {})
  await page.waitForFunction(() => {
    const prm = window.Sys?.WebForms?.PageRequestManager?.getInstance?.()
    return !prm || !prm.get_isInAsyncPostBack()
  }, null, { timeout: 15_000 }).catch(() => {})
  await page.waitForTimeout(300)
}

async function textoError(page) {
  const el = page.locator('#FrmLLamadasServ_LblError')
  if (!(await el.count().catch(() => 0))) return ''
  return (await el.first().innerText({ timeout: 1_000 }).catch(() => '')).trim()
}

async function login(page) {
  for (let intento = 1; intento <= 3; intento++) {
    await page.goto(`${BASE}/Login.aspx`, { waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.locator('#FrmAcceso1_TxtUsuario').waitFor({ state: 'visible', timeout: 15_000 })
    await page.locator('#FrmAcceso1_TxtUsuario').fill(USUARIO)
    await page.locator('#FrmAcceso1_TxtPassword').fill(PASSWORD)
    await page.locator('#FrmAcceso1_TxtPassword').press('Enter')
    await page.waitForURL((u) => !/Login/i.test(u.pathname), { timeout: 8_000 }).catch(() => {})
    await esperarCSHP(page)
    if (/Login/i.test(page.url())) {
      const boton = page.getByRole('button', { name: 'Submit', exact: true })
      if (await boton.count()) { await boton.click().catch(() => {}); await esperarCSHP(page) }
    }
    if (!/Login|BloqSeguridad/i.test(page.url())) { console.log('🔐 Sesión iniciada en CSHP'); return }
    console.warn(`   ⚠️ Inicio de sesión no aceptado (intento ${intento}/3)`)
    await page.waitForTimeout(2000)
  }
  await page.screenshot({ path: 'capturas/login-fallido.png', fullPage: true }).catch(() => {})
  throw new Error(`No se pudo iniciar sesión en CSHP con ${USUARIO} (${ES_PROD ? 'PRODUCCIÓN' : 'QA'}). Captura: capturas\\login-fallido.png`)
}

/** Elige una opción por valor, por texto o por texto que la contenga. Si no existe, muestra las opciones */
async function elegirFiltro(page, selector, buscado, variable) {
  const combo = page.locator(selector)
  await combo.waitFor({ state: 'visible', timeout: 15_000 })
  const ops = await combo.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: (o.textContent || '').trim() })))
  const b = buscado.toLowerCase()
  const op = ops.find((o) => o.v.toLowerCase() === b) || ops.find((o) => o.t.toLowerCase() === b)
    || ops.find((o) => o.v && (o.t.toLowerCase().includes(b) || o.v.toLowerCase().includes(b)))
  if (!op) {
    const lista = ops.map((o) => `   ${o.v.padEnd(12)} ${o.t}`).join('\n')
    throw new Error(`No existe "${buscado}" en ${selector} (${variable} del .env). Opciones de ${ES_PROD ? 'PRODUCCIÓN' : 'QA'}:\n${lista}`)
  }
  await combo.selectOption(op.v)
  await esperarCSHP(page)
  console.log(`   ↳ ${variable}: ${op.v} · ${op.t}`)
  return op.v
}

// ─── Pasos ───────────────────────────────────────────────────────────────────
const filtros = { centro: null, status: null }

/** true si la lista ya está abierta con el centro y status correctos (después de Aceptar) */
async function filtrosPuestos(page) {
  if (!filtros.centro || !/LLamadasServ/i.test(page.url())) return false
  if (!(await page.locator('#FrmLLamadasServ_CmdBuscar').isVisible().catch(() => false))) return false
  const c = await page.locator('#FrmLLamadasServ_CmbFCentro').inputValue().catch(() => '')
  const e = await page.locator('#FrmLLamadasServ_CmbFStatus').inputValue().catch(() => '')
  return c === filtros.centro && e === filtros.status
}

async function buscarLlamadas(page, numero = '') {
  if (!(await filtrosPuestos(page))) {
    await page.goto(`${BASE}/LLamadasServ.aspx`, { waitUntil: 'domcontentloaded' })
    if (/Login|BloqSeguridad/i.test(page.url())) {
      await login(page)
      await page.goto(`${BASE}/LLamadasServ.aspx`, { waitUntil: 'domcontentloaded' })
    }
    await esperarCSHP(page)
    filtros.centro = await elegirFiltro(page, '#FrmLLamadasServ_CmbFCentro', CENTRO, 'CSHP_CENTRO')
    filtros.status = await elegirFiltro(page, '#FrmLLamadasServ_CmbFStatus', ESTADO_BUSCAR, 'CSHP_ESTADO_BUSCAR')
  }
  await page.locator('#FrmLLamadasServ_TxtFLlamada').fill(numero)
  console.log(`   ↳ Buscando ${numero || 'todas las llamadas'}...`)
  await clic(page, '#FrmLLamadasServ_CmdBuscar')
  await esperarCSHP(page)
  const textos = await page.getByRole('link', { name: PATRON }).allTextContents()
  return [...new Set(textos.map((t) => t.trim().toUpperCase()))]
}

async function cambiarStatus(page, numero) {
  await clic(page, '#FrmLLamadasServ_CmdCambiarStatus')
  await esperarCSHP(page)
  const combo = page.locator('#FrmLLamadasServ_CmbStatusN')
  const hayCombo = await combo.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false)

  if (hayCombo && ESTADO_NUEVO) {
    const ops = await combo.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: (o.textContent || '').trim() })))
    const op = ops.find((o) => o.v === ESTADO_NUEVO || o.t.toLowerCase() === ESTADO_NUEVO.toLowerCase())
    if (!op) throw new Error(`No aparece "${ESTADO_NUEVO}" en Nuevo Status. Opciones: ${ops.map((o) => `${o.v}=${o.t}`).join(' | ')}`)
    await combo.selectOption(op.v)
    await esperarCSHP(page)
  }
  const elegido = hayCombo ? await combo.evaluate((s) => s.options[s.selectedIndex]?.text?.trim() || '').catch(() => '') : ''

  await clic(page, '#FrmLLamadasServ_CmdAceptarCambio')
  await esperarCSHP(page)
  if (hayCombo && await combo.isVisible().catch(() => false)) {
    await clic(page, '#FrmLLamadasServ_CmdAceptarCambio')
    await esperarCSHP(page)
  }
  const err = await textoError(page)
  if (err && /error|no se|inv[aá]lid|no permit|requer|obligat/i.test(err)) throw new Error(`CSHP: ${err}`)
  if (hayCombo && await combo.isVisible().catch(() => false)) throw new Error('Se presionó Aceptar en Cambio de Status pero la ventana sigue abierta')

  anotar(numero, 'status', elegido ? { nuevo: elegido } : {})
  console.log(`   ↳ Status cambiado${elegido ? ` → ${elegido}` : ''}`)
}

// ─── Impresión: un navegador por impresora ───────────────────────────────────
// Chromium recuerda la impresora del PRIMER documento que imprime y ya no la cambia, aunque cambie
// la predeterminada de Windows. Por eso hay dos navegadores: el principal (CSHP + guías) y otro solo
// para diagnósticos. Cada uno imprime primero con su impresora como predeterminada y se queda con ella.

/** Direcciones del visor (el iframe del botón y los iframes que lo contienen) */
// Los documentos son PDF: el botón Imprimir es del visor de PDF de Chromium
// (chrome-extension://…/index.html, igual para TODOS los PDF). La dirección útil es la del PDF.
function urlsVisor(frame) {
  const urls = []
  for (let f = frame; f && f.parentFrame(); f = f.parentFrame()) {
    const u = f.url()
    if (u && !/^(about|javascript|data|blob|chrome-extension|chrome):/i.test(u) && !urls.includes(u)) urls.push(u)
  }
  return urls
}

/** Huella (sha1) del PDF que entrega CSHP en esa dirección, para distinguir guía de diagnóstico */
async function huella(page, url) {
  if (!url) return null
  const r = await page.context().request.get(url, { timeout: 15_000 }).catch(() => null)
  if (!r || !r.ok()) return null
  return createHash('sha1').update(await r.body()).digest('hex')
}

/**
 * Botón "Imprimir" en un visor NUEVO. `aceptar(frame)` decide si ese visor sirve
 * (para el diagnóstico: que su PDF NO sea el de la guía).
 */
async function botonImprimir(page, usados = new Set(), timeout = 30_000, aceptar = null) {
  const limite = Date.now() + timeout
  while (Date.now() < limite) {
    for (const frame of [...page.frames()].reverse()) {
      if (usados.has(frame) || frame.isDetached()) continue
      const b = frame.getByRole('button', { name: 'Imprimir', exact: true }).first()
      if (!(await b.isVisible().catch(() => false))) continue
      if (aceptar && !(await aceptar(frame))) continue
      return { frame, boton: b }
    }
    await page.waitForTimeout(500)
  }
  throw new Error(aceptar ? 'No apareció el visor del diagnóstico (solo se veía el PDF de la guía)' : 'No apareció el botón Imprimir en el visor')
}

async function imprimirAqui(page, boton, impresora) {
  usarImpresora(impresora)
  await boton.click()
  await page.waitForTimeout(ESPERA_IMPRESION)
}

/** Abre el visor (misma sesión de CSHP) en el navegador de diagnósticos e imprime ahí */
async function imprimirEnDiag(frame, principal, diag, impresora, soloProbar = false) {
  const urls = urlsVisor(frame)
  if (!urls.length) throw new Error('El visor del diagnóstico no tiene una dirección que se pueda abrir en el otro navegador')
  await diag.context().clearCookies()
  await diag.context().addCookies(await principal.context().cookies())
  for (const url of urls) {
    await diag.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {})
    await esperarCSHP(diag)
    const r = await botonImprimir(diag, new Set(), 15_000).catch(() => null)
    if (!r) continue
    if (!soloProbar) await imprimirAqui(diag, r.boton, impresora)
    return url
  }
  await diag.screenshot({ path: 'capturas/visor-diagnostico.png', fullPage: true }).catch(() => {})
  throw new Error(`El visor del diagnóstico no mostró Imprimir en el otro navegador. Probé: ${urls.join(' | ')}. Captura: capturas\\visor-diagnostico.png`)
}

async function abrirLlamada(page, numero) {
  await page.getByRole('link', { name: numero, exact: true }).first().click()
  await esperarCSHP(page)
  await page.locator('#FrmLLamadasServ_CmdCambiarStatus').waitFor({ state: 'visible', timeout: 15_000 })
}

async function procesar(page, diag, numero, impresoras) {
  await abrirLlamada(page, numero)
  anotar(numero, 'abrir')

  await cambiarStatus(page, numero)

  const usados = new Set(page.frames())
  await clic(page, '#FrmLLamadasServ_CmdGuiaEnvio')
  await esperarCSHP(page)
  const g = await botonImprimir(page, usados)
  usados.add(g.frame)
  const urlGuia = urlsVisor(g.frame)[0]
  const hGuia = await huella(page, urlGuia)
  await imprimirAqui(page, g.boton, impresoras.guia)
  anotar(numero, 'guia', { impresora: impresoras.guia, visor: urlGuia, pdf: hGuia?.slice(0, 10) })
  console.log(`   🖨️  Guía → ${impresoras.guia}`)

  await clic(page, '#FrmLLamadasServ_CmdDiagnostico')
  await esperarCSHP(page)
  // Que el PDF del diagnóstico no sea el de la guía (CSHP puede usar la misma dirección para los dos)
  let hDiag = null
  const esDiagnostico = async (frame) => {
    const u = urlsVisor(frame)[0]
    if (!u) return false
    hDiag = await huella(page, u)
    if (u !== urlGuia) return true
    return Boolean(hDiag && hGuia && hDiag !== hGuia)
  }
  const d = await botonImprimir(page, usados, 30_000, esDiagnostico)
  usados.add(d.frame)
  if (hDiag && hGuia && hDiag === hGuia) throw new Error('El PDF del diagnóstico es idéntico al de la guía: no se imprimió para no duplicar la guía')
  const urlDiag = await imprimirEnDiag(d.frame, page, diag, impresoras.diagnostico)
  anotar(numero, 'diagnostico', { impresora: impresoras.diagnostico, visor: urlDiag, pdf: hDiag?.slice(0, 10) })
  console.log(`   🖨️  Diagnóstico → ${impresoras.diagnostico}`)

  await clic(page, '#FrmLLamadasServ_CmdAceptar')
  await esperarCSHP(page)
  await page.locator('#FrmLLamadasServ_CmdBuscar').waitFor({ state: 'visible', timeout: 15_000 })
  anotar(numero, 'aceptar', { estado: 'completa' })
}

/** QA: abre una llamada SIN cambiar status, abre el diagnóstico y revisa que se pueda imprimir en el otro navegador */
async function probarVisor(page, diag, numero) {
  console.log(`🔎 Probando visor con ${numero} (no cambia status ni imprime)`)
  await abrirLlamada(page, numero)
  const usados = new Set(page.frames())
  await clic(page, '#FrmLLamadasServ_CmdDiagnostico')
  const d = await botonImprimir(page, usados).catch(() => null)
  if (!d) {
    await page.screenshot({ path: 'capturas/probar-visor.png', fullPage: true }).catch(() => {})
    throw new Error('El diagnóstico no abrió su visor antes de cambiar status. Captura: capturas\\probar-visor.png')
  }
  const url = await imprimirEnDiag(d.frame, page, diag, null, true)
  console.log(`   ✅ El visor se abre en el navegador de diagnósticos: ${url}`)
  console.log('   Puedes correr:  npm.cmd run qa')
}

// ─── Candado: una sola corrida a la vez ──────────────────────────────────────
const CANDADO = '.sync.lock'
function tomarCandado() {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(CANDADO, 'wx')
      writeSync(fd, JSON.stringify({ pid: process.pid, inicio: ahora() }))
      closeSync(fd)
      process.on('exit', () => { try { unlinkSync(CANDADO) } catch { /* ya no existe */ } })
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(130))
      return true
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let pid = 0
      try { pid = JSON.parse(readFileSync(CANDADO, 'utf8')).pid } catch { /* dañado */ }
      const vivo = (() => { try { process.kill(pid, 0); return true } catch (x) { return x.code === 'EPERM' } })()
      if (pid && vivo && Date.now() - statSync(CANDADO).mtimeMs < 2 * 60 * 60_000) return false
      try { unlinkSync(CANDADO) } catch { /* otro lo borró */ }
    }
  }
  return false
}

// ─── Principal ───────────────────────────────────────────────────────────────
async function main() {
  const inicioCorrida = Date.now()
  console.log(`\n🚀 Guías y diagnósticos · ${ES_PROD ? '⚠️  PRODUCCIÓN' : 'QA'} · ${BASE} · ${CENTRO} / status ${ESTADO_BUSCAR}${SOLO_LISTAR ? ' · SOLO LISTAR' : ''}\n`)
  if (!tomarCandado()) {
    console.log('⏸️  Ya hay otra corrida en proceso en esta PC. Se omite esta.')
    if (!SOLO_LISTAR && !PROBAR_VISOR) resumen('OMITIDA corrida: la anterior sigue trabajando')
    return
  }

  mon.trabajando(null, 'Buscando llamadas')
  const revisar = Object.keys(registro).filter(pendienteRevision)
  if (revisar.length) {
    console.warn('🟠 Llamadas que quedaron a medias en corridas anteriores (revísalas a mano y luego bórralas de registro.json):')
    revisar.forEach((n) => console.warn(`   ${n}: pasos hechos → ${registro[n].pasos.map((p) => p.paso).join(', ')}`))
    console.log()
  }

  const impresoras = SOLO_LISTAR ? null : impresorasDelEnv()
  const original = SOLO_LISTAR ? null : impresoraPredeterminada()
  mkdirSync('capturas', { recursive: true })

  // Con --kiosk-printing el diálogo de impresión se confirma solo (necesita navegador visible).
  // Cada navegador se abre con SU impresora como predeterminada (ver "Impresión" arriba)
  const abrir = async (impresora) => {
    if (impresora) usarImpresora(impresora)
    const b = await chromium.launch({ headless: false, slowMo: LENTO ? 250 : 0, args: ['--kiosk-printing'] })
    const p = await (await b.newContext()).newPage()
    p.setDefaultTimeout(30_000)
    // Playwright CANCELA por defecto los confirm(): aquí se aceptan
    p.on('dialog', async (d) => { console.log(`   💬 CSHP: ${d.message()}`); await d.accept().catch(() => {}) })
    return { b, p }
  }
  const principal = await abrir(impresoras?.guia)
  const segundo = SOLO_LISTAR ? null : await abrir(impresoras.diagnostico)
  const page = principal.p
  const diag = segundo?.p

  const intentadas = new Set()
  let hechas = 0
  try {
    await login(page)
    let primera = true
    while (hechas < MAX) {
      // Con SOLO_LLAMADAS escribe el número en la búsqueda (más rápido y aunque esté en otra página)
      const buscada = SOLO.find((n) => !intentadas.has(n)) || ''
      if (SOLO.length && !buscada) break
      const lista = await buscarLlamadas(page, buscada || FILTRO)
      if (primera) {
        console.log(`📋 ${lista.length} llamada(s) encontradas${lista.length ? `: ${lista.join(', ')}` : ''}\n`)
        primera = false
        if (SOLO_LISTAR) break
      }
      if (PROBAR_VISOR) {
        const n = lista.find((x) => !SOLO.length || SOLO.includes(x))
        if (!n) { console.log('No hay llamadas para probar.'); break }
        await probarVisor(page, diag, n)
        break
      }
      const numero = lista.find((n) => !intentadas.has(n) && !pendienteRevision(n) && (!SOLO.length || SOLO.includes(n)))
      if (!numero && buscada) {
        intentadas.add(buscada)
        console.warn(`   ⚠️ ${buscada} no aparece en ${CENTRO} con status ${ESTADO_BUSCAR}`)
        continue
      }
      if (!numero) break
      intentadas.add(numero)
      console.log(`⏳ ${numero}`)
      mon.trabajando(numero)
      const inicio = Date.now()
      try {
        await procesar(page, diag, numero, impresoras)
        hechas++
        const seg = Math.round((Date.now() - inicio) / 1000)
        console.log(`   ✅ Completada (${seg} s)`)
        resumen(`OK      ${numero}  guía → ${impresoras.guia} · diagnóstico → ${impresoras.diagnostico} (${seg} s)`)
      } catch (e) {
        await page.screenshot({ path: `capturas/error-${numero}.png`, fullPage: true }).catch(() => {})
        anotar(numero, 'error', { estado: 'error', error: e.message })
        if (yaCambioStatus(numero)) {
          resumen(`ERROR   ${numero}  pasos: ${registro[numero].pasos.map((p) => p.paso).join(' > ')} · ${e.message.split('\n')[0]} · captura: capturas\\error-${numero}.png  >> CORRIDA DETENIDA`)
          console.error(`   ❌ ${e.message}\n   🛑 La llamada ya cambió de status: se detiene la corrida para no seguir sin imprimir.`)
          console.error(`      Revisa ${numero} a mano. Captura: capturas\\error-${numero}.png`)
          process.exitCode = 1
          break
        }
        console.warn(`   ⚠️ ${e.message} (no se cambió nada, se sigue con la siguiente)`)
        resumen(`OMITIDA ${numero}  ${e.message.split('\n')[0]} (no se cambió nada)`)
      }
    }
  } finally {
    if (original) { try { usarImpresora(original) } catch { /* se intentó */ } }
    await principal.b.close()
    if (segundo) await segundo.b.close()
  }
  console.log(`\n🏁 Terminado. Procesadas: ${hechas}`)
  // Una línea por corrida (aunque no haya llamadas): la usa el monitor en vivo (npm.cmd run vivo)
  if (!SOLO_LISTAR && !PROBAR_VISOR) {
    const seg = Math.round((Date.now() - inicioCorrida) / 1000)
    resumen(`--- corrida ${ES_PROD ? 'PROD' : 'QA'}: ${hechas ? `${hechas} llamada(s) impresa(s)` : 'sin llamadas pendientes'}${intentadas.size > hechas ? ` · ${intentadas.size - hechas} con problema` : ''} (${seg} s)`)
  }
}

main().catch((e) => { resumen(`ERROR   ${e.message.split('\n')[0]}`); console.error('❌', e.message); mon.flush().finally(() => process.exit(1)) })

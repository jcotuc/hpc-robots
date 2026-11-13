/**
 * Robot de solicitud de repuestos → CSHP  (usuario genérico de técnico)
 *
 * Por cada solicitud:
 *   1. Abre la llamada (Llamadas de Servicio → filtro → link exacto)
 *   2. Lee el número SAP de la llamada (lo necesita el robot de despacho en HH)
 *   3. Técnico: si ya tiene el mismo, no toca; si está vacío, lo asigna; si tiene OTRO, se detiene
 *   4. Por repuesto: si ya está en la llamada lo salta (no duplica); si no, código + cantidad + Agregar
 *      y verifica que aparezca (CSHP guarda al instante)
 *
 * Modos:
 *   npm.cmd run verificar    revisa .env, tablas de la app y pendientes (solo lee)
 *   npm.cmd run qa           solicitudes de la app (Supabase) contra CSHP QA, navegador visible
 *   npm.cmd run prod:visible solicitudes de la app contra CSHP PRODUCCIÓN, visible
 *   npm.cmd run prod         igual, sin navegador (tarea programada)
 *   npm.cmd run prueba       QA con datos del .env (PRUEBA_*), sin Supabase
 *   npm.cmd run leer         QA, solo lectura de la llamada de prueba
 *
 * App (Supabase): rep_solicitudes / rep_solicitud_lineas / rep_eventos / rep_config
 *   toma solicitudes 'pendiente' → en CSHP → 'en_cshp' (+ num_sap) o 'error_cshp' (+ error_motivo)
 *   líneas: 'cargado_cshp' o 'error_cshp'. Solo trabaja si rep_config.robot_solicitud_activo = true
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { crearMonitor } from '../shared/monitor.mjs'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs'
import { salirSiKardex } from '../shared/kardex-pausa.mjs'

// ─── Configuración ─────────────────────────────────────────────────────────
const arg = (a) => process.argv.includes(a)
const PROD = arg('--prod') || (!arg('--qa') && /^prod/i.test(process.env.AMBIENTE || ''))
const BASE = ((PROD ? process.env.CSHP_PROD_URL : process.env.CSHP_QA_URL)
  || (PROD ? 'https://taller.hpc.com.gt/CSHP' : 'https://tallerqa.hpc.com.gt/CSHP')).replace(/\/(Login\.aspx)?$/i, '')
const ES_PROD = !/tallerqa/i.test(BASE)
const USUARIO = (PROD && process.env.CSHP_PROD_USUARIO) || process.env.CSHP_USUARIO
const PASSWORD = (PROD && process.env.CSHP_PROD_PASSWORD) || process.env.CSHP_PASSWORD
const SOLO_LEER = arg('--solo-leer')
const PRUEBA = arg('--prueba')
const VISIBLE = arg('--visible') || arg('--lento')
const LENTO = arg('--lento')
const PATRON = /^LL[SM]\d+-\d+$/i
const REGISTRO = 'registro.json'
const APP = !PRUEBA && !SOLO_LEER          // modo normal: solicitudes de la app en Supabase
const ROBOT = (process.env.ROBOT_NOMBRE || 'robot-solicitud-repuestos').trim().toLowerCase()
const MAX = Number(process.env.MAX_SOLICITUDES ?? 0) || Infinity
const RESERVA_MS = 30 * 60 * 1000

if (!USUARIO || !PASSWORD) { console.error('❌ Falta CSHP_USUARIO / CSHP_PASSWORD en .env  (notepad .env)'); process.exit(1) }
if (ES_PROD && PRUEBA) { console.error('❌ --prueba solo se permite en QA'); process.exit(1) }
if (APP && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)) { console.error('❌ Falta SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY de la app en .env'); process.exit(1) }
const sb = APP ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }) : null
await salirSiKardex('solicitud-repuestos')   // pausa mientras Kardex actualiza inventario en esta PC

// Dungeon: solo con MONITOR_SUPABASE_URL propio (el SUPABASE_URL de este robot es el de la app, no el del dungeon)
const mon = crearMonitor('solicitud-repuestos', { activo: APP && ES_PROD && Boolean(process.env.MONITOR_SUPABASE_URL), centro: 'Nodus' })

// ─── Logs y registro ───────────────────────────────────────────────────────
const ahora = () => new Date().toISOString()
const horaGT = () => new Date().toLocaleTimeString('es-GT', { timeZone: 'America/Guatemala', hour12: false })
const fechaGT = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' })
function log(linea) {
  console.log(linea)
  try { mkdirSync('logs', { recursive: true }); appendFileSync(`logs/detalle-${fechaGT()}.log`, `${horaGT()}  ${linea}\r\n`) } catch { /* nunca detiene */ }
}
function resumen(linea) {
  mon.linea(linea)
  try { mkdirSync('logs', { recursive: true }); appendFileSync(`logs/resumen-${fechaGT()}.log`, `${horaGT()}  ${linea}\r\n`) } catch { /* nunca detiene */ }
}
let registro = {}
try { registro = JSON.parse(readFileSync(REGISTRO, 'utf8')) } catch { /* primera vez */ }
function anotar(numero, paso, extra = {}) {
  const k = `${ES_PROD ? 'prod' : 'qa'}:${numero}`
  const r = (registro[k] ||= { inicio: ahora(), pasos: [] })
  r.pasos.push({ paso, hora: ahora(), ...extra })
  try { writeFileSync(REGISTRO, JSON.stringify(registro, null, 2)) } catch { /* nunca detiene */ }
}
const sinCeros = (x) => String(x ?? '').trim().replace(/^0+/, '')

// ─── CSHP (mismo patrón que digitadores) ───────────────────────────────────
async function clic(page, selector) {
  try { await page.locator(selector).click({ timeout: 5_000 }) }
  catch { await page.evaluate((s) => document.querySelector(s)?.click(), selector) }
}
async function esperarCSHP(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 1_500 }).catch(() => {})
  await page.waitForFunction(() => {
    const prm = window.Sys?.WebForms?.PageRequestManager?.getInstance?.()
    return !prm || !prm.get_isInAsyncPostBack()
  }, null, { timeout: 20_000 }).catch(() => {})
  await page.waitForTimeout(LENTO ? 1_000 : 300)
}
async function textoError(page) {
  const el = page.locator('#FrmLLamadasServ_LblError')
  if (!(await el.count().catch(() => 0))) return ''
  return (await el.first().innerText({ timeout: 1_000 }).catch(() => '')).trim()
}
async function revisarError(page, paso) {
  const err = await textoError(page)
  if (err && /error|no se|no exist|inv[aá]lid|no permit|requer|obligat|debe|existencia/i.test(err)) throw new Error(`CSHP en ${paso}: ${err}`)
  return err
}
async function captura(page, nombre) {
  mkdirSync('capturas', { recursive: true })
  const ruta = `capturas/${nombre}-${Date.now()}.png`
  await page.screenshot({ path: ruta, fullPage: true }).catch(() => {})
  return ruta
}

async function login(page) {
  for (let intento = 1; intento <= 3; intento++) {
    await page.goto(`${BASE}/Login.aspx`, { waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.locator('#FrmAcceso1_TxtUsuario').waitFor({ state: 'visible', timeout: 15_000 })
    await page.locator('#FrmAcceso1_TxtUsuario').fill(USUARIO)
    await page.locator('#FrmAcceso1_TxtPassword').fill(PASSWORD)
    await page.locator('#FrmAcceso1_TxtPassword').press('Enter')
    await page.waitForURL((u) => !/Login/i.test(u.pathname), { timeout: 10_000 }).catch(() => {})
    await esperarCSHP(page)
    if (!/Login|BloqSeguridad/i.test(page.url())) { log('🔐 Sesión iniciada en CSHP'); return }
    log(`   ⚠️ Inicio de sesión no aceptado (intento ${intento}/3)`)
    await page.waitForTimeout(2_000)
  }
  throw new Error(`No se pudo iniciar sesión en CSHP con ${USUARIO}. Captura: ${await captura(page, 'login')}`)
}

async function abrirLlamada(page, numero) {
  await page.goto(`${BASE}/LLamadasServ.aspx`, { waitUntil: 'domcontentloaded' })
  if (/Login|BloqSeguridad/i.test(page.url())) { await login(page); await page.goto(`${BASE}/LLamadasServ.aspx`, { waitUntil: 'domcontentloaded' }) }
  await esperarCSHP(page)
  const link = page.getByRole('link', { name: numero, exact: true })
  for (let intento = 1; intento <= 2; intento++) {
    await page.locator('#FrmLLamadasServ_TxtFLlamada').fill(numero)
    await clic(page, '#FrmLLamadasServ_CmdBuscar')
    await esperarCSHP(page)
    if (await link.first().waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false)) break
  }
  const n = await link.count()
  if (n !== 1) throw new Error(n ? `Aparece ${n} veces ${numero} en la lista` : `No se encontró ${numero} en CSHP`)
  await link.click()
  await esperarCSHP(page)
  await page.locator('#FrmLLamadasServ_TxtRepuesto, #FrmLLamadasServ_CmdAsignarTec').first()
    .waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new Error(`CSHP no terminó de abrir ${numero} (no aparece Repuesto ni Asignar técnico)`) })
}

/** Campos cuyo id coincide con el patrón (para descubrir dónde están SAP y técnico) */
async function camposPorId(page, re) {
  return page.evaluate((src) => {
    const r = new RegExp(src, 'i')
    return [...document.querySelectorAll('input, select, span, textarea')]
      .filter((e) => r.test(e.id))
      .map((e) => ({
        id: e.id,
        valor: (e.tagName === 'SELECT' ? e.options[e.selectedIndex]?.text : (e.value ?? e.textContent) ?? '').trim(),
        visible: e.offsetParent !== null,
      }))
  }, re.source).catch(() => [])
}

/** Valor de un campo de CSHP: input (value) o span/label (texto). null si el campo no existe */
async function valorCampo(page, selector) {
  const el = page.locator(selector).first()
  if (!(await el.count().catch(() => 0))) return null
  return el.evaluate((e) => ('value' in e && e.tagName !== 'SPAN' ? e.value : e.textContent) ?? '').then((v) => String(v).trim()).catch(() => null)
}

/** Número SAP de la llamada (#FrmLLamadasServ_TxtDocSAP, confirmado en QA) */
async function numeroSAP(page) {
  const v = await valorCampo(page, '#FrmLLamadasServ_TxtDocSAP')
  return v && /^\d+$/.test(v) ? v : null
}

/** Técnico asignado: #FrmLLamadasServ_TxtTecnico = "TB30004 JOSHUA COTUC" → { codigo, texto }.
 *  Si el campo no existe se detiene: nunca asigna sin poder leer quién está asignado */
async function tecnicoActual(page) {
  const texto = await valorCampo(page, '#FrmLLamadasServ_TxtTecnico')
  if (texto === null) throw new Error('No se encontró el campo Técnico Asignado en la llamada. No se cambió nada')
  const codigo = (texto.match(/^([A-Z]{1,3}\d+)\b/i) || [])[1]?.toUpperCase() || ''
  return { codigo, texto }
}

/** Tabla "Repuestos Solicitados" de la llamada (encabezado: Linea | SKU | Nombre | Solicitado | Despachado |
 *  Solicitante | Fecha Solicitud | Status | Despachador). Se ubica por encabezado, no por id */
async function solicitados(page) {
  return page.evaluate(() => {
    const txt = (c) => c.textContent.replace(/\s+/g, ' ').trim()
    for (const t of document.querySelectorAll('table')) {
      if (t.offsetParent === null) continue
      const filas = [...t.querySelectorAll(':scope > tbody > tr, :scope > tr, :scope > thead > tr')].map((tr) => [...tr.children].map(txt))
      const i = filas.findIndex((f) => f.includes('SKU') && f.includes('Solicitado'))
      if (i < 0) continue
      const enc = filas[i]
      const col = (n) => enc.indexOf(n)
      return filas.slice(i + 1).filter((f) => /^\d+$/.test(f[col('SKU')] || '')).map((f) => ({
        linea: f[col('Linea')], sku: f[col('SKU')], nombre: f[col('Nombre')],
        solicitado: Number(f[col('Solicitado')]), despachado: Number(f[col('Despachado')]),
        solicitante: f[col('Solicitante')], fecha: f[col('Fecha Solicitud')], status: f[col('Status')],
      }))
    }
    return null
  }).catch(() => null)
}

/** SKUs ya solicitados y aún pendientes en la llamada (para no duplicar). Uno completado/despachado sí se puede volver a pedir */
async function skusEnLlamada(page, skus) {
  const filas = await solicitados(page)
  if (!filas) throw new Error('No se encontró la tabla Repuestos Solicitados en la llamada. No se cambió nada')
  // Solo cuentan las que siguen abiertas: status "Pendiente" (Completada/Despachada ya no bloquean un pedido nuevo)
  const pend = filas.filter((f) => /pend/i.test(f.status || '') || (!f.status && f.despachado < f.solicitado))
  return skus.filter((s) => pend.some((f) => sinCeros(f.sku) === sinCeros(s)))
}

async function asignarTecnico(page, codigo) {
  await clic(page, '#FrmLLamadasServ_CmdAsignarTec')
  await esperarCSHP(page)
  const combo = page.locator('#FrmLLamadasServ_CmbTecnicoN')
  await combo.waitFor({ state: 'visible', timeout: 15_000 })
  const ops = await combo.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: (o.textContent || '').trim() })))
  const op = ops.find((o) => o.v.toUpperCase() === codigo.toUpperCase())
  if (!op) throw new Error(`El técnico ${codigo} no aparece en CSHP. Hay ${ops.length} opciones (ej. ${ops.slice(1, 4).map((o) => `${o.v}=${o.t}`).join(' | ')})`)
  await combo.selectOption(op.v)
  await esperarCSHP(page)
  await clic(page, '#FrmLLamadasServ_CmdAceptarTec')
  await esperarCSHP(page)
  await revisarError(page, `Asignar técnico ${codigo}`)
  return op.t
}

/** Cantidad solicitada del SKU (última línea con ese SKU) */
async function cantidadEnLlamada(page, sku) {
  const filas = await solicitados(page)
  const f = (filas || []).filter((x) => sinCeros(x.sku) === sinCeros(sku)).at(-1)
  return f ? f.solicitado : null
}

async function agregarRepuesto(page, sku, cantidad) {
  const txt = page.locator('#FrmLLamadasServ_TxtRepuesto')
  await txt.waitFor({ state: 'visible', timeout: 15_000 })
  // Código → salir del cuadro y esperar: CSHP busca el artículo (postback) y eso borraba la cantidad
  await txt.fill(String(sku))
  await txt.press('Tab').catch(() => {})
  await esperarCSHP(page)
  await revisarError(page, `Código ${sku}`)
  // La cantidad a veces se borra porque el postback del código termina después: hasta 4 intentos
  const cant = page.locator('#FrmLLamadasServ_TxtCantidadRep')
  let escrita = ''
  for (let intento = 1; intento <= 4; intento++) {
    await page.waitForTimeout(intento === 1 ? 500 : 1_500)
    await esperarCSHP(page)
    await cant.fill(String(cantidad).padStart(2, '0'))
    await cant.press('Tab').catch(() => {})
    await esperarCSHP(page)
    await page.waitForTimeout(700)
    escrita = await cant.inputValue().catch(() => '')
    if (Number(escrita) === Number(cantidad)) break
    log(`   ↻ La cantidad de ${sku} quedó en "${escrita}" (intento ${intento}/4), se vuelve a escribir`)
  }
  if (Number(escrita) !== Number(cantidad)) throw new Error(`La cantidad de ${sku} quedó en "${escrita}" antes de Agregar (se pidió ${cantidad}). No se agregó`)
  await clic(page, '#FrmLLamadasServ_CmdAddRep')
  await esperarCSHP(page)
  await revisarError(page, `Agregar repuesto ${sku}`)
  const quedo = await skusEnLlamada(page, [sku])
  if (!quedo.length) throw new Error(`Se presionó Agregar pero ${sku} no aparece en la llamada. Captura: ${await captura(page, `rep-${sku}`)}`)
  const enTabla = await cantidadEnLlamada(page, sku)
  if (enTabla === null) throw new Error(`${sku} no aparece en Repuestos Solicitados después de Agregar`)
  if (Number(enTabla) !== Number(cantidad)) throw new Error(`${sku} quedó con cantidad ${enTabla} en la llamada (se pidió ${cantidad})`)
}

// ─── Proceso ───────────────────────────────────────────────────────────────
async function procesar(page, s) {
  const numero = s.llamada.toUpperCase()
  log(`\n▶️  ${numero} · técnico ${s.tecnico} · ${s.repuestos.length} repuesto(s)`)
  await abrirLlamada(page, numero)

  const sap = await numeroSAP(page)
  const tec = await tecnicoActual(page)
  const ya = await skusEnLlamada(page, s.repuestos.map((r) => r.sku))
  log(`   ↳ SAP: ${sap ?? '(no identificado)'} · técnico actual: ${tec.texto || '(vacío)'} · ya en la llamada: ${ya.join(', ') || 'ninguno'}`)

  if (SOLO_LEER) {
    const filas = await solicitados(page)
    log(`   🔎 Repuestos Solicitados: ${filas ? filas.length : 'tabla no encontrada'}`)
    for (const f of filas || []) log(`      ${f.linea}. ${f.sku} × ${f.solicitado} (despachado ${f.despachado}) · ${f.status} · ${f.solicitante} · ${f.fecha}`)
    log(`   📸 ${await captura(page, `${numero}-lectura`)}`)
    resumen(`${numero}  LEIDA  SAP ${sap ?? '?'} · técnico ${tec.texto || 'vacío'} · ya cargados ${ya.length}/${s.repuestos.length}`)
    return 'leida'
  }

  // Técnico: mismo código → no toca · vacío → asigna · otro → se detiene (no le quita la llamada a nadie)
  if (tec.codigo && tec.codigo !== s.tecnico) throw new Error(`La llamada ya tiene otro técnico (${tec.texto}); se pidió ${s.tecnico}. No se cambió nada`)
  if (!tec.codigo && tec.texto) throw new Error(`No se reconoce el técnico asignado ("${tec.texto}"). No se cambió nada`)
  if (tec.codigo) log(`   ↳ Técnico ${tec.texto} ya asignado: no se reasigna`)
  else {
    const nombre = await asignarTecnico(page, s.tecnico)
    anotar(numero, 'tecnico', { codigo: s.tecnico, nombre })
    log(`   ↳ Técnico asignado: ${nombre}`)
  }
  if (!sap) log('   ⚠️ La llamada no tiene número SAP: el robot de despacho no podrá buscarla en HH')
  s.sap = sap

  const cargados = [], saltados = []
  for (const r of s.repuestos) {
    if (ya.some((x) => sinCeros(x) === sinCeros(r.sku))) {
      saltados.push(r.sku); log(`   ↪️ ${r.sku} ya estaba en la llamada: no se duplica`)
      await s.alCargar?.(r, 'ya_estaba'); continue
    }
    try { await agregarRepuesto(page, r.sku, r.cantidad) }
    catch (e) { await s.alFallar?.(r, String(e.message || e).split('\n')[0]); throw e }
    anotar(numero, 'repuesto', { sku: r.sku, cantidad: r.cantidad })
    cargados.push(r.sku)
    log(`   ↳ Agregado ${r.sku} × ${r.cantidad}`)
    await s.alCargar?.(r, 'agregado')
  }
  anotar(numero, 'completa', { sap, cargados, saltados })
  resumen(`${numero}  OK  SAP ${sap ?? '?'} · ${cargados.length} agregados${saltados.length ? ` · ${saltados.length} ya estaban` : ''}`)
  return 'ok'
}

/** Datos de prueba: del .env (PRUEBA_LLAMADA, PRUEBA_TECNICO, PRUEBA_REPUESTOS=18023:2,925207:1) o de prueba.json */
function solicitudesDePrueba() {
  let p
  if (process.env.PRUEBA_LLAMADA) {
    p = {
      llamada: process.env.PRUEBA_LLAMADA,
      tecnico: process.env.PRUEBA_TECNICO,
      repuestos: String(process.env.PRUEBA_REPUESTOS || '').split(',').map((x) => x.trim()).filter(Boolean)
        .map((x) => { const [sku, cantidad] = x.split(/[:x×\s-]+/i); return { sku, cantidad: cantidad ?? 1 } }),
    }
    log('🧪 Datos de prueba desde .env')
  } else {
    p = JSON.parse(readFileSync('prueba.json', 'utf8').replace(/^\uFEFF/, ''))
    log('🧪 Datos de prueba desde prueba.json')
  }
  const llamada = String(p.llamada || '').trim().toUpperCase()
  if (!PATRON.test(llamada)) throw new Error(`Prueba: la llamada no es válida (${p.llamada})`)
  if (!/^[A-Z]{1,3}\d+$/i.test(String(p.tecnico || '').trim())) throw new Error('Prueba: el técnico debe ser el código (ej. TB30004)')
  const repuestos = (p.repuestos || []).map((r) => ({ sku: String(r.sku).trim(), cantidad: Number(r.cantidad) }))
  if (!repuestos.length || repuestos.some((r) => !/^\d+$/.test(r.sku) || !(r.cantidad > 0))) throw new Error('Prueba: los repuestos deben ser SKU:cantidad, ej. 18023:2,925207:1')
  log(`   ${llamada} · ${String(p.tecnico).trim().toUpperCase()} · ${repuestos.map((r) => `${r.sku}×${r.cantidad}`).join(', ')}`)
  return [{ llamada, tecnico: String(p.tecnico).trim().toUpperCase(), repuestos }]
}

// ─── App (Supabase) ────────────────────────────────────────────────────────
async function robotActivo() {
  const { data, error } = await sb.from('rep_config').select('valor').eq('clave', 'robot_solicitud_activo').maybeSingle()
  if (error) throw new Error(`Supabase (rep_config): ${error.message}`)
  return data?.valor === true || data?.valor === 'true'
}
async function evento(solicitud_id, accion, detalle = {}, linea_id = null) {
  const { error } = await sb.from('rep_eventos').insert({ solicitud_id, linea_id, actor: ROBOT, accion, detalle })
  if (error) log(`   ⚠️ No se pudo registrar el evento ${accion}: ${error.message}`)
}
async function solicitudesDeApp() {
  const limite = Date.now() - RESERVA_MS
  const { data, error } = await sb.from('rep_solicitudes')
    .select('id, created_at, num_llamada, tecnico_codigo, solicitante_nombre, solicitante_correo, robot_tomado_por, robot_tomado_en, robot_intentos, rep_solicitud_lineas(id, sku, cantidad, estado)')
    .eq('estado', 'pendiente').order('created_at', { ascending: true }).limit(50)
  if (error) throw new Error(`Supabase (rep_solicitudes): ${error.message}`)
  return data.filter((a) => !a.robot_tomado_por || !a.robot_tomado_en || new Date(a.robot_tomado_en).getTime() <= limite || a.robot_tomado_por === ROBOT)
}
/** Reserva atómica: solo si sigue 'pendiente' y nadie más la tomó */
async function reservar(a) {
  const limite = new Date(Date.now() - RESERVA_MS).toISOString()
  const { data, error } = await sb.from('rep_solicitudes')
    .update({ robot_tomado_por: ROBOT, robot_tomado_en: ahora(), robot_intentos: (a.robot_intentos || 0) + 1 })
    .eq('id', a.id).eq('estado', 'pendiente')
    .or(`robot_tomado_por.is.null,robot_tomado_en.is.null,robot_tomado_en.lte.${limite},robot_tomado_por.eq.${ROBOT}`)
    .select('id')
  if (error) throw new Error(`Supabase (reservar): ${error.message}`)
  return data.length === 1
}
async function actualizarLinea(id, cambios) {
  const { error } = await sb.from('rep_solicitud_lineas').update(cambios).eq('id', id)
  if (error) log(`   ⚠️ No se pudo actualizar la línea ${id}: ${error.message}`)
}
async function cerrarSolicitud(a, cambios) {
  const { error } = await sb.from('rep_solicitudes').update({ ...cambios, robot_tomado_por: null, robot_tomado_en: null }).eq('id', a.id)
  if (error) log(`   ⚠️ No se pudo actualizar la solicitud ${a.num_llamada}: ${error.message}`)
}
/** Convierte una solicitud de la app al formato del robot, con los avisos por línea hacia Supabase */
function desdeApp(a) {
  const lineas = (a.rep_solicitud_lineas || []).filter((l) => l.estado === 'pendiente')
  const porSku = new Map(lineas.map((l) => [sinCeros(l.sku), l]))
  return {
    id: a.id,
    llamada: String(a.num_llamada || '').trim().toUpperCase(),
    tecnico: String(a.tecnico_codigo || '').trim().toUpperCase(),
    repuestos: lineas.map((l) => ({ sku: String(l.sku).trim(), cantidad: Number(l.cantidad), lineaId: l.id })),
    alCargar: async (r, como) => {
      const l = porSku.get(sinCeros(r.sku)); if (!l) return
      await actualizarLinea(l.id, { estado: 'cargado_cshp', cargado_cshp_en: ahora(), error_motivo: null })
      await evento(a.id, como === 'ya_estaba' ? 'linea_ya_estaba_en_cshp' : 'linea_cargada_cshp', { sku: r.sku, cantidad: r.cantidad }, l.id)
    },
    alFallar: async (r, motivo) => {
      const l = porSku.get(sinCeros(r.sku)); if (!l) return
      await actualizarLinea(l.id, { estado: 'error_cshp', error_motivo: motivo.slice(0, 500) })
      await evento(a.id, 'linea_error_cshp', { sku: r.sku, motivo }, l.id)
    },
  }
}

const LOCK = '.sync.lock'
function tomarLock() {
  try { if (Date.now() - statSync(LOCK).mtimeMs > 30 * 60 * 1000) unlinkSync(LOCK) } catch { /* no existe */ }
  try { closeSync(openSync(LOCK, 'wx')); return true } catch { return false }
}

async function main() {
  log(`\n=== Robot solicitud de repuestos · CSHP ${ES_PROD ? 'PRODUCCIÓN' : 'QA'} · ${BASE}${SOLO_LEER ? ' · SOLO LECTURA' : ''}${APP ? ' · app Supabase' : ''} ===`)
  let lista, crudas = []
  if (APP) {
    if (!(await robotActivo())) { log('⏹️  robot_solicitud_activo está APAGADO en la app (Admin). No se procesa nada.'); resumen('--- corrida sin solicitudes (robot APAGADO)'); return }
    crudas = (await solicitudesDeApp()).slice(0, MAX)
    lista = crudas.map(desdeApp)
    log(`📋 ${lista.length} solicitud(es) pendiente(s)`)
    for (const s of lista) log(`   · ${s.llamada}  ${s.tecnico}  ${s.repuestos.map((r) => `${r.sku}×${r.cantidad}`).join(', ')}`)
    if (arg('--solo-listar')) { log('🔎 Solo listar: no se abre CSHP'); return }
    if (!lista.length) { mon.fin('Sin solicitudes'); resumen('--- corrida sin solicitudes'); await mon.flush(); return }
    if (!tomarLock()) { log('⏳ Otra corrida sigue activa (.sync.lock). Se sale.'); return }
  } else lista = solicitudesDePrueba()

  const browser = await chromium.launch({ headless: !VISIBLE, slowMo: LENTO ? 250 : 0 })
  const page = await (await browser.newContext()).newPage()
  const cuenta = { ok: 0, leida: 0, error: 0, tomada: 0 }
  try {
    await login(page)
    for (const [i, s] of lista.entries()) {
      const a = crudas[i]
      // Validaciones antes de tocar CSHP
      const invalida = !PATRON.test(s.llamada) ? `Número de llamada inválido: "${s.llamada}"`
        : !/^[A-Z]{1,3}\d+$/.test(s.tecnico) ? `Código de técnico inválido: "${s.tecnico}"`
        : !s.repuestos.length ? 'La solicitud no tiene líneas pendientes'
        : s.repuestos.find((r) => !/^\d+$/.test(r.sku) || !(r.cantidad > 0)) ? 'Hay líneas con SKU o cantidad inválida' : null
      if (APP) {
        if (!(await reservar(a))) { log(`   ↪️ ${s.llamada} ya la tomó otro proceso, se salta`); cuenta.tomada++; continue }
        if (invalida) {
          await cerrarSolicitud(a, { estado: 'error_cshp', error_motivo: invalida })
          await evento(a.id, 'error_cshp', { motivo: invalida })
          log(`   ❌ ${s.llamada}: ${invalida}`); resumen(`${s.llamada}  ERROR  ${invalida}`); cuenta.error++; continue
        }
        await evento(a.id, 'robot_tomo', { intento: (a.robot_intentos || 0) + 1 })
      }
      mon.trabajando(s.llamada)
      try {
        cuenta[await procesar(page, s)]++
        if (APP) {
          await cerrarSolicitud(a, { estado: 'en_cshp', num_sap: s.sap, error_motivo: null })
          await evento(a.id, 'cargada_en_cshp', { num_sap: s.sap })
        }
      } catch (e) {
        cuenta.error++
        const motivo = String(e.message || e).split('\n')[0]
        const ruta = await captura(page, s.llamada)
        log(`   ❌ ${motivo}  (captura: ${ruta})`)
        anotar(s.llamada, 'error', { motivo, captura: ruta })
        resumen(`${s.llamada}  ERROR  ${motivo}`)
        if (APP) {
          await cerrarSolicitud(a, { estado: 'error_cshp', error_motivo: motivo.slice(0, 500), ...(s.sap ? { num_sap: s.sap } : {}) })
          await evento(a.id, 'error_cshp', { motivo, captura: ruta })
        }
        if (/iniciar sesión/i.test(motivo)) break
      }
    }
  } finally {
    await browser.close().catch(() => {})
    if (APP) try { unlinkSync(LOCK) } catch { /* ya no existe */ }
    const fin = `${cuenta.ok} ok · ${cuenta.leida} leídas · ${cuenta.error} con error${cuenta.tomada ? ` · ${cuenta.tomada} tomadas por otro` : ''}`
    log(`\n✅ Fin: ${fin}`)
    resumen(`--- corrida: ${fin}`)
    await mon.flush()
  }
}

main().catch(async (e) => { log(`❌ ${e.message || e}`); resumen(`--- corrida ERROR  ${String(e.message || e).split('\n')[0]}`); await mon.flush(); process.exitCode = 1 })

/**
 * Robot de despacho de repuestos → CSHP HH  (usuario de bodega)
 *
 * Por cada llamada con repuestos pickeados:
 *   1. HH → "Respuestos Llamada" → número SAP + Enter
 *   2. Por cada pantalla: identifica qué SKU muestra (debe ser UNO de los pickeados) →
 *      ubicación de origen + cantidad pickeada → Submit
 *   3. Verifica que la pantalla avance (otro SKU o fin). Si no avanza o sale error, se detiene
 *      (nunca vuelve a presionar Submit en la misma pantalla: no duplica)
 *
 * Modos:
 *   npm.cmd run leer       SOLO LEE: entra con el SAP de PRUEBA_SAP y muestra la pantalla (no Submit)
 *   npm.cmd run prueba     QA con PRUEBA_SAP y PRUEBA_DESPACHO del .env (sin Supabase)
 *   npm.cmd run qa | prod:visible | prod   líneas 'pickeado' de la app (Supabase)
 *
 * App: solicitudes con num_sap y todas sus líneas decididas. Bodega (CS) 'pickeado' y Autoservicio (KB)
 *   'cargado_cshp' → 'despachado' (+ despachado_en; KB además rep_confirmar_descarga_kb) o 'error_despacho'.
 *   Solo trabaja si rep_config.robot_despacho_activo = true
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { crearMonitor } from '../shared/monitor.mjs'
import { loginHH, abrirLlamadaHH, leerPantallaHH, irARepuestoHH, skuEditableHH, despacharPantalla } from '../shared/hh.mjs'
import { loginCSHP, abrirLlamadaCSHP, leerLlamadaCSHP } from '../shared/cshp-llamada.mjs'
import { mkdirSync, appendFileSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs'
import { salirSiKardex } from '../shared/kardex-pausa.mjs'

// ─── Configuración ─────────────────────────────────────────────────────────
const arg = (a) => process.argv.includes(a)
const PROD = arg('--prod') || (!arg('--qa') && /^prod/i.test(process.env.AMBIENTE || ''))
const BASE = ((PROD ? process.env.CSHP_PROD_URL : process.env.CSHP_QA_URL)
  || (PROD ? 'https://taller.hpc.com.gt/CSHP' : 'https://tallerqa.hpc.com.gt/CSHP')).replace(/\/(HH\/.*|Login\.aspx)?$/i, '')
const ES_PROD = !/tallerqa/i.test(BASE)
const USUARIO = (PROD && process.env.HH_PROD_USUARIO) || process.env.HH_USUARIO
const PASSWORD = (PROD && process.env.HH_PROD_PASSWORD) || process.env.HH_PASSWORD
const SOLO_LEER = arg('--solo-leer')
const PRUEBA = arg('--prueba')
const APP = !PRUEBA && (!SOLO_LEER || arg('--app'))   // --solo-leer --app: lee de Supabase y solo revisa en HH
const VISIBLE = arg('--visible') || arg('--lento')
const LENTO = arg('--lento')
const ROBOT = (process.env.ROBOT_NOMBRE || 'robot-despacho-repuestos').trim().toLowerCase()
const sinCeros = (x) => String(x ?? '').trim().replace(/^0+/, '')

if (!USUARIO || !PASSWORD) { console.error('❌ Falta HH_USUARIO / HH_PASSWORD en .env  (usuario de bodega)'); process.exit(1) }
if (ES_PROD && PRUEBA) { console.error('❌ --prueba solo se permite en QA'); process.exit(1) }
if (APP && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)) { console.error('❌ Falta SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY de la app en .env'); process.exit(1) }
const sb = APP ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }) : null
await salirSiKardex('despacho-repuestos')   // pausa mientras Kardex actualiza inventario en esta PC
const mon = crearMonitor('despacho-repuestos', { activo: APP && ES_PROD && Boolean(process.env.MONITOR_SUPABASE_URL), centro: 'Nodus' })

// ─── Logs ──────────────────────────────────────────────────────────────────
const ahora = () => new Date().toISOString()
const horaGT = () => new Date().toLocaleTimeString('es-GT', { timeZone: 'America/Guatemala', hour12: false })
const fechaGT = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' })
function log(l) { console.log(l); try { mkdirSync('logs', { recursive: true }); appendFileSync(`logs/detalle-${fechaGT()}.log`, `${horaGT()}  ${l}\r\n`) } catch { /* nunca detiene */ } }
function resumen(l) { mon.linea(l); try { mkdirSync('logs', { recursive: true }); appendFileSync(`logs/resumen-${fechaGT()}.log`, `${horaGT()}  ${l}\r\n`) } catch { /* nunca detiene */ } }
async function captura(page, nombre) {
  mkdirSync('capturas', { recursive: true })
  const ruta = `capturas/${nombre}-${Date.now()}.png`
  await page.screenshot({ path: ruta, fullPage: true }).catch(() => {})
  return ruta
}

// ─── Despacho de una llamada ───────────────────────────────────────────────
const UBIC_NODUS = /^(CS|KB)/i

/** d = { llamada, sap, tecnico?, lineas: [{ sku, cantidad, ubicacion, id? }], alDespachar?, alFallar? }
 *  Por cada línea: TxtSKU + Enter (va directo a ese repuesto) → valida → Agregar cantidad desde la ubicación → Aceptar */
async function despachar(page, d) {
  const clave = d.sap || d.llamada
  log(`\n▶️  ${d.llamada || ''}${d.sap ? ` SAP ${d.sap}` : ''} · en HH con ${clave} · ${d.lineas.map((l) => `${l.sku}×${l.cantidad}@${l.ubicacion}`).join(', ')}`)
  await abrirLlamadaHH(page, BASE, clave)
  const p0 = await leerPantallaHH(page)
  log(`   ↳ HH: llamada ${p0.llamada || '?'} · técnico ${p0.tecnico || '?'} · primer repuesto ${p0.sku || '(ninguno)'} ${p0.nombre}`)
  if (!p0.llamada) throw new Error(`HH no cargó la llamada ${clave}${p0.mensajes.length ? `: ${p0.mensajes.join(' ')}` : ''}`)
  if (d.tecnico && p0.tecnico && p0.tecnico.toUpperCase() !== d.tecnico.toUpperCase()) {
    throw new Error(`En HH la llamada tiene el técnico ${p0.tecnico} y la solicitud es de ${d.tecnico}. No se despachó nada`)
  }

  const igual = (x, y) => sinCeros(x) === sinCeros(y)
  const editable = await skuEditableHH(page)
  log(`   ↳ Campo SKU ${editable ? 'editable (se puede ir a cada repuesto)' : 'BLOQUEADO (HH muestra los repuestos en su orden)'}`)

  if (SOLO_LEER) {
    for (const l of d.lineas) {
      const p = await irARepuestoHH(page, l.sku)
      if (!igual(p.sku, l.sku)) { log(`   🔎 ${l.sku}: no se puede revisar sin despachar antes ${p.sku} (HH muestra uno a la vez)`); continue }
      const nodus = p.sugeridas.filter((u) => UBIC_NODUS.test(u.ubicacion))
      const u = p.sugeridas.find((x) => x.ubicacion === String(l.ubicacion || '').toUpperCase())
      const listo = p.pideUbicacion && p.solicitado >= l.cantidad && u && u.disponible >= l.cantidad
        && (!d.tecnico || !p0.tecnico || p0.tecnico.toUpperCase() === d.tecnico.toUpperCase())
      log(`   🔎 ${l.sku}: ${p.nombre} · solicitado ${p.solicitado}`)
      log(`      Nodus: ${nodus.map((x) => `${x.ubicacion}=${x.disponible}`).join(', ') || 'sin ubicaciones CS/KB'} · pedida: ${l.ubicacion || '?'}`)
      log(`      ${listo ? '✅ Se podría despachar' : '❌ NO se despacharía'}: ${l.cantidad} desde ${l.ubicacion || '?'} (disp ${u ? u.disponible : 'no aparece'}, solicitado ${p.solicitado}, técnico HH ${p0.tecnico} / app ${d.tecnico || '?'})`)
    }
    log(`   📸 ${await captura(page, `hh-${clave}-lectura`)}`)
    return 'leida'
  }

  let hechos = 0
  const pendientes = [...d.lineas]
  for (let vuelta = 0; pendientes.length && vuelta < 40; vuelta++) {
    // Con SKU editable: ir al siguiente pendiente. Bloqueado: tomar el que muestra HH
    let p = await irARepuestoHH(page, pendientes[0].sku)
    let l = pendientes.find((x) => igual(x.sku, p.sku))
    if (!l) {
      throw new Error(p.sku ? `HH muestra ${p.sku} (${p.nombre}), que no está listo para despacho en la app, y no deja cambiar de repuesto. Faltan: ${pendientes.map((x) => x.sku).join(', ')}`
        : `HH ya no muestra repuestos y faltan: ${pendientes.map((x) => x.sku).join(', ')}`)
    }
    const motivo = !p.pideUbicacion ? `HH no permite despachar ${l.sku} (sin campo de ubicación)`
      : p.solicitado < l.cantidad ? `${l.sku}: se quiere despachar ${l.cantidad} y en HH el solicitado es ${p.solicitado}` : null
    const sug = p.sugeridas.find((u) => u.ubicacion === l.ubicacion.toUpperCase())
    const motivo2 = motivo || (!sug ? `${l.ubicacion} no aparece en Ubicaciones Sugeridas de ${l.sku}`
      : sug.disponible < l.cantidad ? `${l.ubicacion} tiene ${sug.disponible} disponible(s) de ${l.sku}; se piden ${l.cantidad}` : null)
    if (motivo2) { await d.alFallar?.(l, motivo2); throw new Error(motivo2) }

    const avisos = await despacharPantalla(page, l.ubicacion, l.cantidad)
    const despues = await leerPantallaHH(page)
    const err = [...avisos, ...despues.mensajes].find((m) => /error|no hay|no exist|insuficien|inv[aá]lid|no se|no puede|excede/i.test(m))
    if (err) { await d.alFallar?.(l, err); throw new Error(`HH en ${l.sku}: ${err}`) }
    const avanzo = !igual(despues.sku, l.sku) || despues.solicitado < p.solicitado
    if (!avanzo) { await d.alFallar?.(l, 'HH no confirmó el despacho'); throw new Error(`HH no confirmó el despacho de ${l.sku} (sigue igual). Revisar a mano; no se repite`) }
    log(`   ↳ Despachado ${l.sku} × ${l.cantidad} desde ${l.ubicacion}${avisos.length ? ` (aviso: ${avisos.join(' | ')})` : ''}`)
    hechos++
    pendientes.splice(pendientes.indexOf(l), 1)
    await d.alDespachar?.(l)
  }
  resumen(`${d.llamada || clave}  OK  ${hechos} despachados`)
  return 'ok'
}

// ─── Fuentes de trabajo ────────────────────────────────────────────────────
/** .env: PRUEBA_SAP=1024424  PRUEBA_DESPACHO=18023:2:KB1.001.01,925207:1:CS101.01.3.7 */
function deEnv() {
  const sap = String(process.env.PRUEBA_SAP || '').trim()
  const llamada = String(process.env.PRUEBA_LLAMADA || '').trim().toUpperCase()
  if (!/^\d+$/.test(sap) && !/^LL[SM]\d+-\d+$/.test(llamada)) throw new Error('Pon PRUEBA_LLAMADA (LLS21-...) o PRUEBA_SAP en .env')
  const lineas = String(process.env.PRUEBA_DESPACHO || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const [sku, cantidad, ubicacion] = x.split(':').map((y) => y.trim())
    return { sku, cantidad: Number(cantidad), ubicacion }
  })
  if (!SOLO_LEER && (!lineas.length || lineas.some((l) => !/^\d+$/.test(l.sku) || !(l.cantidad > 0) || !l.ubicacion))) {
    throw new Error('PRUEBA_DESPACHO debe ser SKU:cantidad:ubicación, ej. 18023:2:KB1.001.01,925207:1:CS101.01.3.7')
  }
  return [{ llamada, sap: /^\d+$/.test(sap) ? sap : null, lineas }]
}

async function robotActivo() {
  const { data, error } = await sb.from('rep_config').select('valor').eq('clave', 'robot_despacho_activo').maybeSingle()
  if (error) throw new Error(`Supabase (rep_config): ${error.message}`)
  return data?.valor === true || data?.valor === 'true'
}
async function evento(solicitud_id, accion, detalle = {}, linea_id = null) {
  const { error } = await sb.from('rep_eventos').insert({ solicitud_id, linea_id, actor: ROBOT, accion, detalle })
  if (error) log(`   ⚠️ No se pudo registrar el evento ${accion}: ${error.message}`)
}
/** Estados en los que una línea ya está "decidida" (no falta nada de bodega ni del robot de solicitud) */
const LISTA_CS = new Set(['pickeado', 'no_disponible', 'despachado', 'error_despacho', 'cancelada'])
const LISTA_KB = new Set(['cargado_cshp', 'despachado', 'error_despacho', 'cancelada'])

/**
 * Solicitudes listas para HH: tienen num_sap y TODAS sus líneas decididas
 *   Bodega (CS): 'pickeado' → se despacha desde la ubicación que dejó bodega (cantidad_pickeada)
 *   Autoservicio (KB): 'cargado_cshp' sin inventario_descontado_en → se despacha desde su KB y se confirma la descarga
 * Se espera a que toda la solicitud esté lista porque HH muestra los repuestos de la llamada uno tras otro.
 */
async function deApp() {
  const { data, error } = await sb.from('rep_solicitudes')
    .select('id, num_llamada, num_sap, estado, tecnico_codigo, rep_solicitud_lineas(id, sku, estado, autoservicio, ubicacion_origen, cantidad_pickeada, cantidad, inventario_descontado_en)')
    .in('estado', ['en_cshp', 'en_bodega', 'completa'])
    .order('created_at', { ascending: true }).limit(30)
  if (error) throw new Error(`Supabase (rep_solicitudes): ${error.message}`)
  const listas = []
  for (const s of data) {
    const ls = s.rep_solicitud_lineas || []
    const faltan = ls.filter((l) => !(l.autoservicio ? LISTA_KB : LISTA_CS).has(l.estado))
    if (faltan.length) continue // bodega aún no termina (o falta el robot de solicitud)
    const despachar = ls.filter((l) => (l.autoservicio ? l.estado === 'cargado_cshp' && !l.inventario_descontado_en : l.estado === 'pickeado'))
    if (!despachar.length) continue
    const noDisp = ls.filter((l) => l.estado === 'no_disponible').map((l) => l.sku)
    listas.push({
      solicitudId: s.id, llamada: s.num_llamada, sap: s.num_sap, tecnico: s.tecnico_codigo, noDisponibles: noDisp,
      lineas: despachar.map((l) => ({
        id: l.id, kb: !!l.autoservicio, sku: String(l.sku).trim(),
        cantidad: Number(l.autoservicio ? l.cantidad : (l.cantidad_pickeada ?? l.cantidad)),
        ubicacion: String(l.ubicacion_origen || '').trim().toUpperCase(),
      })),
      alDespachar: async (l) => {
        let kbOk = null
        if (l.kb) {
          // Autoservicio: libera la cuarentena y descuenta la existencia una sola vez
          const { error: e } = await sb.rpc('rep_confirmar_descarga_kb', { _linea_id: l.id })
          kbOk = !e
          if (e) log(`   ⚠️ ${l.sku}: despachado en HH pero rep_confirmar_descarga_kb falló (${e.message}). Confirmar en la app`)
        }
        const { error: e2 } = await sb.from('rep_solicitud_lineas').update({ estado: 'despachado', despachado_en: ahora(), error_motivo: null }).eq('id', l.id)
        if (e2) log(`   ⚠️ No se pudo marcar despachado ${l.sku}: ${e2.message}`)
        await evento(s.id, 'linea_despachada', { sku: l.sku, cantidad: l.cantidad, ubicacion: l.ubicacion, autoservicio: l.kb, ...(l.kb ? { descarga_kb_confirmada: kbOk } : {}) }, l.id)
      },
      alFallar: async (l, motivo) => {
        await sb.from('rep_solicitud_lineas').update({ estado: 'error_despacho', error_motivo: String(motivo).slice(0, 500) }).eq('id', l.id)
        await evento(s.id, 'linea_error_despacho', { sku: l.sku, motivo }, l.id)
      },
    })
  }
  return listas
}

const LOCK = '.sync.lock'
function tomarLock() {
  try { if (Date.now() - statSync(LOCK).mtimeMs > 30 * 60 * 1000) unlinkSync(LOCK) } catch { /* no existe */ }
  try { closeSync(openSync(LOCK, 'wx')); return true } catch { return false }
}

// ─── Principal ─────────────────────────────────────────────────────────────
async function main() {
  log(`\n=== Robot despacho de repuestos · HH ${ES_PROD ? 'PRODUCCIÓN' : 'QA'} · ${BASE}${SOLO_LEER ? ' · SOLO LECTURA' : ''}${APP ? ' · app Supabase' : ''} ===`)
  let lista
  if (APP) {
    if (!(await robotActivo())) { log('⏹️  robot_despacho_activo está APAGADO en la app (Admin). No se procesa nada.'); resumen('--- corrida sin despachos (robot APAGADO)'); return }
    lista = await deApp()
    const sinUbic = lista.flatMap((d) => d.lineas.filter((l) => !l.ubicacion).map((l) => `${d.llamada}/${l.sku}`))
    if (sinUbic.length) log(`⚠️ Líneas pickeadas sin ubicación de origen (se saltan): ${sinUbic.join(', ')}`)
    lista = lista.map((d) => ({ ...d, lineas: d.lineas.filter((l) => l.ubicacion && l.cantidad > 0) })).filter((d) => d.lineas.length)
    log(`📋 ${lista.length} llamada(s) lista(s) para despachar en HH`)
    for (const d of lista) log(`   · ${d.llamada} SAP ${d.sap}  ${d.lineas.map((l) => `${l.sku}×${l.cantidad}@${l.ubicacion}${l.kb ? '(KB)' : ''}`).join(', ')}${d.noDisponibles.length ? `  · no disponibles: ${d.noDisponibles.join(', ')}` : ''}`)
    if (arg('--solo-listar')) { log('🔎 Solo listar: no se abre HH'); return }
    if (!lista.length) { mon.fin('Sin despachos'); resumen('--- corrida sin despachos'); await mon.flush(); return }
    if (!tomarLock()) { log('⏳ Otra corrida sigue activa (.sync.lock). Se sale.'); return }
  } else lista = deEnv()

  const browser = await chromium.launch({ headless: !VISIBLE, slowMo: LENTO ? 250 : 0 })
  const page = await (await browser.newContext()).newPage()
  const cuenta = { ok: 0, leida: 0, error: 0 }
  try {
    // Sin SAP (solo número de llamada): se lee la llamada en CSHP — SAP, técnico y tablas de repuestos
    for (const d of lista.filter(() => arg('--cshp'))) {
      if (!d.llamada) continue
      await loginCSHP(page, BASE, process.env.CSHP_USUARIO || USUARIO, process.env.CSHP_PASSWORD || PASSWORD)
      await abrirLlamadaCSHP(page, BASE, d.llamada)
      const ll = await leerLlamadaCSHP(page)
      d.sap ||= ll.sap
      log(`\n📄 ${d.llamada} en CSHP · SAP ${ll.sap ?? '(sin SAP)'} · técnico ${ll.tecnico || '(vacío)'}`)
      log(`   Repuestos Solicitados: ${ll.solicitados ? ll.solicitados.length : 'tabla no encontrada'}`)
      for (const r of ll.solicitados || []) log(`      ${r.Linea}. ${r.SKU} × ${r.Solicitado} · despachado ${r.Despachado} · ${r.Status} · ${r.Solicitante} · ${r['Fecha Solicitud']}`)
      log(`   Repuestos Registrados: ${ll.registrados ? ll.registrados.length : 'tabla no encontrada'}`)
      for (const r of ll.registrados || []) log(`      ${r.SKU} × ${r['Cant.']} · ${r.Origen} → ${r.Destino}`)
      log(`   📸 ${await captura(page, `cshp-${d.llamada}`)}`)
    }
    await loginHH(page, BASE, USUARIO, PASSWORD)
    log('🔐 Sesión iniciada en HH')
    for (const d of lista) {
      mon.trabajando(d.llamada || d.sap)
      try {
        cuenta[await despachar(page, d)]++
        if (APP && !SOLO_LEER) await evento(d.solicitudId, 'despacho_terminado', { num_sap: d.sap })
      } catch (e) {
        cuenta.error++
        const motivo = String(e.message || e).split('\n')[0]
        const ruta = await captura(page, `hh-${d.sap}`)
        log(`   ❌ ${motivo}  (captura: ${ruta})`)
        resumen(`${d.llamada || d.sap}  ERROR  ${motivo}`)
        if (APP && !SOLO_LEER) await evento(d.solicitudId, 'error_despacho', { motivo, captura: ruta })
        if (/iniciar sesión/i.test(motivo)) break
      }
    }
  } finally {
    await browser.close().catch(() => {})
    if (APP) try { unlinkSync(LOCK) } catch { /* ya no existe */ }
    const fin = `${cuenta.ok} ok · ${cuenta.leida} leídas · ${cuenta.error} con error`
    log(`\n✅ Fin: ${fin}`)
    resumen(`--- corrida: ${fin}`)
    await mon.flush()
  }
}

main().catch(async (e) => { log(`❌ ${e.message || e}`); resumen(`--- corrida ERROR  ${String(e.message || e).split('\n')[0]}`); await mon.flush(); process.exitCode = 1 })

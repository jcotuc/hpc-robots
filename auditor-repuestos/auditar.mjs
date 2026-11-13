/**
 * Auditor de repuestos — revisa en CSHP (SOLO LECTURA) que lo hecho en la app quedó igual en la llamada.
 *   Etapa "solicitud": cada repuesto cargado a CSHP aparece en "Repuestos Solicitados" con la misma cantidad.
 *   Etapa "despacho":  cada repuesto despachado aparece en "Repuestos Registrados" con esa ubicación de origen y cantidad.
 * Cada línea se audita UNA vez por etapa (rep_auditoria). Las diferencias llegan por correo (correos_cola → robot de correos),
 * un correo por llamada. Si no puede leer CSHP no marca nada: lo reintenta en la siguiente corrida.
 *
 *   node --env-file=.env auditar.mjs                 corrida normal (la tarea, cada 3 min)
 *   node --env-file=.env auditar.mjs --solo-mostrar  revisa y muestra, NO guarda ni manda correo
 *   --visible                                        con navegador visible
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { crearMonitor } from '../shared/monitor.mjs'
import { loginCSHP, abrirLlamadaCSHP, leerLlamadaCSHP } from '../shared/cshp-llamada.mjs'
import { mkdirSync, appendFileSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { salirSiKardex } from '../shared/kardex-pausa.mjs'
await salirSiKardex('auditor-repuestos')   // pausa mientras Kardex actualiza inventario en esta PC

// ─── Configuración ─────────────────────────────────────────────────────────
const arg = (a) => process.argv.includes(a)
const SOLO = arg('--solo-mostrar')
const VISIBLE = arg('--visible')
const BASE = (process.env.CSHP_PROD_URL || 'https://taller.hpc.com.gt/CSHP').replace(/\/(Login\.aspx)?$/i, '')
const USUARIO = process.env.CSHP_USUARIO, PASSWORD = process.env.CSHP_PASSWORD
const PARA = (process.env.AUDITOR_PARA || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean)
const ESPERA_MS = Number(process.env.ESPERA_MIN || 2) * 60_000
const MAX_LLAMADAS = Number(process.env.MAX_LLAMADAS || 15)
const sinCeros = (x) => String(x ?? '').trim().replace(/^0+/, '')
const U = (x) => String(x ?? '').trim().toUpperCase()

if (!USUARIO || !PASSWORD) { console.error('❌ Falta CSHP_USUARIO / CSHP_PASSWORD en .env'); process.exit(1) }
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) { console.error('❌ Falta SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (ConsumosCS) en .env'); process.exit(1) }
if (!SOLO && !PARA.length) { console.error('❌ Falta AUDITOR_PARA (correos que reciben las diferencias) en .env'); process.exit(1) }
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const mon = crearMonitor('auditor-repuestos', { intervaloSeg: 180, activo: !SOLO, centro: 'Nodus' })

// ─── Fechas y logs (hora de Guatemala) ──────────────────────────────────────
const horaGT = () => new Date().toLocaleTimeString('es-GT', { timeZone: 'America/Guatemala', hour12: false })
const fechaGT = (d = new Date()) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' })   // AAAA-MM-DD
const DESDE = new Date(`${process.env.AUDITAR_DESDE || fechaGT()}T00:00:00-06:00`)
function log(l) { console.log(l); try { mkdirSync('logs', { recursive: true }); appendFileSync(`logs/detalle-${fechaGT()}.log`, `${horaGT()}  ${l}\r\n`) } catch { /* nunca detiene */ } }
function resumen(l) { try { mkdirSync('logs', { recursive: true }); appendFileSync(`logs/resumen-${fechaGT()}.log`, `${horaGT()}  ${l}\r\n`) } catch { /* nunca detiene */ } }
const corto = (e) => String(e?.message || e || '').split('\n')[0].slice(0, 300)
/** "20/06/2024 01:59" → "2024-06-20" (solo el día: la hora de CSHP no trae AM/PM) */
const diaCSHP = (t) => { const m = String(t || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null }
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const LOCK = '.sync.lock'
function tomarLock() {
  try { if (Date.now() - statSync(LOCK).mtimeMs > 10 * 60_000) unlinkSync(LOCK) } catch { /* no existe */ }
  try { closeSync(openSync(LOCK, 'wx')); return true } catch { return false }
}
setTimeout(() => { log('ERROR la auditoría pasó de 2.8 min: se cerró a la fuerza'); try { unlinkSync(LOCK) } catch {} process.exit(3) }, 170_000).unref()

// ─── Supabase ──────────────────────────────────────────────────────────────
async function todas(q) {   // la API devuelve máx. 1000 filas: paginar
  const out = []
  for (let i = 0; ; i += 1000) {
    const { data, error } = await q().range(i, i + 999)
    if (error) throw new Error(error.message)
    out.push(...data)
    if (data.length < 1000) return out
  }
}
const COLS = 'id, solicitud_id, sku, descripcion, cantidad, cantidad_pickeada, ubicacion_origen, autoservicio, estado, cargado_cshp_en, despachado_en, rep_solicitudes!inner(num_llamada, created_at)'
const cant = (l) => Number(l.autoservicio ? l.cantidad : (l.cantidad_pickeada ?? l.cantidad))

/** Qué falta auditar: líneas cargadas/despachadas desde DESDE, con ESPERA_MIN de antigüedad, sin auditar en esa etapa */
async function pendientes() {
  const d = DESDE.toISOString()
  const lineas = await todas(() => sb.from('rep_solicitud_lineas').select(COLS).or(`cargado_cshp_en.gte.${d},despachado_en.gte.${d}`).order('id'))
  const hechas = new Set((await todas(() => sb.from('rep_auditoria').select('linea_id, etapa').gte('creado_en', d).order('id'))).map((a) => `${a.linea_id}|${a.etapa}`))
  const limite = Date.now() - ESPERA_MS
  const tareas = []
  for (const l of lineas) {
    if (l.cargado_cshp_en && new Date(l.cargado_cshp_en) >= DESDE && Date.parse(l.cargado_cshp_en) < limite && !hechas.has(`${l.id}|solicitud`)) tareas.push({ etapa: 'solicitud', l })
    if (l.estado === 'despachado' && l.despachado_en && Date.parse(l.despachado_en) < limite && !hechas.has(`${l.id}|despacho`)) tareas.push({ etapa: 'despacho', l })
  }
  return tareas
}

// ─── Reglas ────────────────────────────────────────────────────────────────
/** Etapa solicitud: por solicitud y SKU, lo pedido en la app = "Solicitado" en CSHP (filas del mismo día de la solicitud) */
function auditarSolicitud(tareas, ll, todasLineas) {
  const out = []
  const grupos = new Map()
  for (const t of tareas) { const k = `${t.l.solicitud_id}|${sinCeros(t.l.sku)}`; (grupos.get(k) || grupos.set(k, []).get(k)).push(t) }
  for (const [k, ts] of grupos) {
    const [solId, sku] = k.split('|')
    const delaSol = todasLineas.filter((x) => x.solicitud_id === solId && sinCeros(x.sku) === sku && x.cargado_cshp_en)
    const esperado = delaSol.reduce((a, x) => a + Number(x.cantidad), 0)
    const dias = new Set([fechaGT(ts[0].l.rep_solicitudes.created_at), ...delaSol.map((x) => fechaGT(x.cargado_cshp_en))])
    const filas = (ll.solicitados || []).filter((r) => sinCeros(r.SKU) === sku)
    const delDia = filas.filter((r) => dias.has(diaCSHP(r['Fecha Solicitud'])))
    const usadas = delDia.length || !filas.some((r) => diaCSHP(r['Fecha Solicitud'])) ? (delDia.length ? delDia : filas) : []
    const enCshp = usadas.reduce((a, r) => a + (Number(r.Solicitado) || 0), 0)
    const motivo = enCshp === esperado ? null
      : !usadas.length ? `No aparece en Repuestos Solicitados${filas.length ? ` (hay ${filas.length} fila(s) de ese SKU de otros días)` : ''}`
      : enCshp < esperado ? `En CSHP hay ${enCshp} solicitado(s); la app pidió ${esperado}`
      : `En CSHP hay ${enCshp} solicitado(s) ese día; la app pidió ${esperado} (¿pedido manual o duplicado?)`
    for (const t of ts) out.push({ ...t, esperado, enCshp, motivo, ubicacion: t.l.ubicacion_origen })
  }
  return out
}

/** Etapa despacho: por SKU + ubicación, total despachado en la app (toda la llamada) = "Cant." en Registrados con ese Origen */
function auditarDespacho(tareas, ll, todasLineas, llamada) {
  const out = []
  const desp = todasLineas.filter((x) => x.rep_solicitudes.num_llamada === llamada && x.estado === 'despachado')
  const grupos = new Map()
  for (const t of tareas) { const k = `${sinCeros(t.l.sku)}|${U(t.l.ubicacion_origen)}`; (grupos.get(k) || grupos.set(k, []).get(k)).push(t) }
  for (const [k, ts] of grupos) {
    const [sku, ubic] = k.split('|')
    const esperado = desp.filter((x) => sinCeros(x.sku) === sku && U(x.ubicacion_origen) === ubic).reduce((a, x) => a + cant(x), 0)
    const regs = (ll.registrados || []).filter((r) => sinCeros(r.SKU) === sku)
    const enCshp = regs.filter((r) => U(r.Origen) === ubic).reduce((a, r) => a + (Number(r['Cant.']) || 0), 0)
    const otras = regs.filter((r) => U(r.Origen) !== ubic).map((r) => `${r.Origen}×${r['Cant.']}`)
    const motivo = enCshp === esperado ? null
      : enCshp === 0 ? `No aparece en Repuestos Registrados desde ${ubic}${otras.length ? ` (sí desde: ${otras.join(', ')})` : ''}`
      : enCshp < esperado ? `Registrado ${enCshp} desde ${ubic}; la app despachó ${esperado}`
      : `Registrado ${enCshp} desde ${ubic}; la app despachó ${esperado} (¿despacho manual o duplicado?)`
    for (const t of ts) out.push({ ...t, esperado, enCshp, motivo, ubicacion: ubic })
  }
  return out
}

// ─── Correo ────────────────────────────────────────────────────────────────
async function encolarCorreo(llamada, fallas) {
  const clave = `auditor_rep:${llamada}:${createHash('sha1').update(fallas.map((f) => `${f.l.id}|${f.etapa}`).sort().join(',')).digest('hex').slice(0, 16)}`
  const filas = fallas.map((f) => `<tr><td>${f.etapa === 'solicitud' ? 'Solicitud' : 'Despacho'}</td><td><b>${esc(f.l.sku)}</b><br><small>${esc(f.l.descripcion || '')}</small></td>`
    + `<td>${esc(f.ubicacion || '')}</td><td style="text-align:center">${f.esperado}</td><td style="text-align:center">${f.enCshp}</td><td>${esc(f.motivo)}</td></tr>`).join('')
  const td = 'style="border:1px solid #ddd;padding:6px"'
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px">
<p>El auditor de repuestos encontró <b>${fallas.length}</b> diferencia(s) entre la app y CSHP en la llamada <b>${esc(llamada)}</b>.</p>
<table style="border-collapse:collapse" cellpadding="6">
<tr style="background:#f3f4f6"><th ${td}>Etapa</th><th ${td}>SKU</th><th ${td}>Ubicación</th><th ${td}>App</th><th ${td}>CSHP</th><th ${td}>Qué pasa</th></tr>
${filas.replace(/<td/g, `<td ${td}`)}
</table>
<p style="color:#6b7280;font-size:12px">Revisión de solo lectura en CSHP · ${new Date().toLocaleString('es-GT', { timeZone: 'America/Guatemala' })} · robot auditor-repuestos</p></div>`
  const { data, error } = await sb.from('correos_cola').upsert({
    tipo: 'auditor_repuestos', para: PARA, asunto: `⚠️ Auditoría repuestos: ${llamada} · ${fallas.length} diferencia(s)`,
    html, referencia: llamada, clave, datos: { llamada, diferencias: fallas.length },
  }, { onConflict: 'clave', ignoreDuplicates: true }).select('id')
  if (error) throw new Error(`No se pudo encolar el correo: ${error.message}`)
  return data?.[0]?.id ?? null
}

// ─── Principal ─────────────────────────────────────────────────────────────
async function main() {
  log(`\n=== Auditor de repuestos · CSHP ${BASE} · desde ${fechaGT(DESDE)}${SOLO ? ' · SOLO MOSTRAR (no guarda ni manda correo)' : ''} ===`)
  const { data: cfg } = await sb.from('rep_config').select('valor').eq('clave', 'robot_auditor_activo').maybeSingle()
  if (cfg && cfg.valor === false) { log('⏹️  robot_auditor_activo = false'); mon.fin('Apagado en la app'); await mon.flush(); return }

  const tareas = await pendientes()
  if (!tareas.length) { log('✔️  Nada nuevo que auditar'); mon.fin('Sin pendientes'); await mon.flush(); return }
  const porLlamada = new Map()
  for (const t of tareas) { const k = t.l.rep_solicitudes.num_llamada; (porLlamada.get(k) || porLlamada.set(k, []).get(k)).push(t) }
  const llamadas = [...porLlamada.keys()].slice(0, MAX_LLAMADAS)
  log(`📋 ${tareas.length} revisión(es) en ${porLlamada.size} llamada(s); esta corrida: ${llamadas.length}`)
  if (!SOLO && !tomarLock()) { log('⏳ Otra corrida sigue activa (.sync.lock). Se sale.'); return }

  // todas las líneas de esas llamadas (sin filtro de fecha) para sumar despachos completos
  const todasLineas = await todas(() => sb.from('rep_solicitud_lineas').select(COLS).in('rep_solicitudes.num_llamada', llamadas).order('id'))
  const browser = await chromium.launch({ headless: !VISIBLE })
  const page = await (await browser.newContext()).newPage()
  const cuenta = { ok: 0, falla: 0, error: 0 }
  try {
    await loginCSHP(page, BASE, USUARIO, PASSWORD)
    for (const llamada of llamadas) {
      const ts = porLlamada.get(llamada)
      mon.trabajando(llamada, `Auditando ${ts.length} revisión(es)`)
      try {
        await abrirLlamadaCSHP(page, BASE, llamada)
        const ll = await leerLlamadaCSHP(page)
        if (!ll.solicitados) throw new Error('No se encontró la tabla Repuestos Solicitados')
        const res = [
          ...auditarSolicitud(ts.filter((t) => t.etapa === 'solicitud'), ll, todasLineas),
          ...auditarDespacho(ts.filter((t) => t.etapa === 'despacho'), ll, todasLineas, llamada),
        ]
        const fallas = res.filter((r) => r.motivo)
        for (const r of res) log(`   ${r.motivo ? '❌' : '✅'} ${llamada} ${r.etapa.padEnd(9)} ${r.l.sku}${r.ubicacion ? '@' + r.ubicacion : ''} app ${r.esperado} · CSHP ${r.enCshp}${r.motivo ? ' · ' + r.motivo : ''}`)
        if (SOLO) { cuenta.ok += res.length - fallas.length; cuenta.falla += fallas.length; continue }
        const correoId = fallas.length ? await encolarCorreo(llamada, fallas) : null
        const { error } = await sb.from('rep_auditoria').upsert(res.map((r) => ({
          solicitud_id: r.l.solicitud_id, linea_id: r.l.id, num_llamada: llamada, etapa: r.etapa,
          resultado: r.motivo ? 'falla' : 'ok', sku: r.l.sku, ubicacion: r.ubicacion || null,
          esperado: r.esperado, en_cshp: r.enCshp, motivo: r.motivo, correo_id: r.motivo ? correoId : null,
        })), { onConflict: 'linea_id,etapa', ignoreDuplicates: true })
        if (error) throw new Error(`No se pudo guardar la auditoría: ${error.message}`)
        cuenta.ok += res.length - fallas.length; cuenta.falla += fallas.length
        if (fallas.length) {
          resumen(`REVISAR ${llamada}: ${fallas.length} diferencia(s) · ${fallas.map((f) => `${f.etapa} ${f.l.sku}`).join(', ')} · correo encolado`)
          mon.revisar(llamada, `${fallas.length} diferencia(s) app vs CSHP · correo enviado`)
        } else {
          resumen(`OK ${llamada}: ${res.length} revisión(es) cuadran`)
          mon.ok(llamada, `${res.length} revisión(es) cuadran`)
        }
      } catch (e) {
        cuenta.error++
        log(`   ⚠️ ${llamada}: no se pudo auditar (${corto(e)}). Se reintenta en la próxima corrida`)
        resumen(`ERROR ${llamada}  ${corto(e)}`)
        mon.error(e, llamada)
      }
    }
  } finally {
    await browser.close().catch(() => {})
    if (!SOLO) try { unlinkSync(LOCK) } catch { /* ya no existe */ }
  }
  const txt = `${cuenta.ok} ok · ${cuenta.falla} con diferencia · ${cuenta.error} sin poder leer`
  log(`\n✅ Fin: ${txt}${porLlamada.size > llamadas.length ? ` · quedan ${porLlamada.size - llamadas.length} llamada(s) para la próxima corrida` : ''}`)
  resumen(`--- corrida ${txt}`)
  if (cuenta.error && !cuenta.ok && !cuenta.falla) mon.error(`No se pudo leer CSHP (${cuenta.error} llamada(s))`)
  else mon.fin(cuenta.falla ? `${cuenta.falla} diferencia(s) · correo enviado` : `${cuenta.ok} revisión(es) cuadran`)
  await mon.flush()
}

main().catch(async (e) => { log(`❌ ${corto(e)}`); resumen(`--- corrida ERROR  ${corto(e)}`); mon.error(e); await mon.flush(); try { unlinkSync(LOCK) } catch {} process.exitCode = 1 })

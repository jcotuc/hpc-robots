/**
 * El Jefe del dungeon — revisa el trabajo de los robots SIN tocar nada (solo lectura) y:
 *   · abre / actualiza / cierra hallazgos en jefe_hallazgos (kkzo) → el dungeon lo muestra yendo al cuarto
 *   · avisa por correo (cola del robot de Correos) cuando abre un hallazgo ALTO
 *   npm.cmd run revisar   (QA: solo imprime lo que encontró)
 *   npm.cmd run prod      (guarda, reporta y avisa)
 */
import { crearMonitor } from '../shared/monitor.mjs'
import { mkdirSync, appendFileSync } from 'node:fs'

const E = process.env, args = process.argv.slice(2)
const PROD = args.includes('--prod') || (!args.includes('--qa') && /^prod/i.test(E.AMBIENTE || ''))
const KK = { nombre: 'kkzo', url: (E.KKZO_URL || '').replace(/\/$/, ''), key: E.KKZO_SERVICE_ROLE_KEY || '' }
const CC = { nombre: 'ConsumosCS', url: (E.CONSUMOS_URL || '').replace(/\/$/, ''), key: E.CONSUMOS_SERVICE_ROLE_KEY || '' }
const ALERTAR_A = String(E.ALERTAR_A || '').split(',').map((x) => x.trim()).filter(Boolean)
const ROBOT_DIG = (E.DIGITADORES_ROBOT || 'robot-digitadores').trim().toLowerCase()
const MIN = (k, d) => Number(E[k] || d)
const mon = crearMonitor('jefe', { intervaloSeg: 300, activo: PROD })

/* Horario de cada robot (igual que su programar-tarea.cmd) para no alarmar fuera de turno */
const LS = [1, 2, 3, 4, 5, 6]
const HORARIOS = {
  citas: { dias: LS, desde: '05:55', hasta: '20:25' }, guias: { dias: LS, desde: '07:00', hasta: '20:00' },
  digitadores: { dias: LS, desde: '07:00', hasta: '18:00' }, correos: { dias: LS, desde: '07:00', hasta: '20:00' },
}
const NOMBRES = { citas: 'Citas', guias: 'Guías', digitadores: 'Digitadores', correos: 'Correos' }

const fechaGT = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' })
const horaGT = (d = new Date()) => new Date(d).toLocaleTimeString('es-GT', { timeZone: 'America/Guatemala', hour: '2-digit', minute: '2-digit', hour12: false })
const haceMin = (m) => new Date(Date.now() - m * 60000).toISOString()
const corto = (x, n = 300) => String(x?.message || x || '').split('\n')[0].slice(0, n)
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
function log(l) {
  console.log(l)
  try { mkdirSync('logs', { recursive: true }); appendFileSync(`logs/resumen-${fechaGT()}.log`, `${horaGT()}  ${l}\r\n`) } catch {}
}
function minEnHorario(robot) {
  const h = HORARIOS[robot]; if (!h) return 9999
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Guatemala', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value]))
  const dia = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)
  const min = (+p.hour % 24) * 60 + +p.minute, aMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3)
  return h.dias.includes(dia) && min >= aMin(h.desde) && min <= aMin(h.hasta) ? min - aMin(h.desde) : null
}

/* PostgREST mínimo (sin dependencias) */
async function q(db, path, { method = 'GET', body, prefer } = {}) {
  if (!db.url || !db.key) throw new Error(`Faltan URL/KEY de ${db.nombre} en .env`)
  const r = await fetch(`${db.url}/rest/v1/${path}`, {
    method, signal: AbortSignal.timeout(20000),
    headers: { apikey: db.key, Authorization: `Bearer ${db.key}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const t = await r.text()
  if (!r.ok) throw new Error(`${db.nombre} ${path.split('?')[0]} HTTP ${r.status}: ${t.slice(0, 200)}`)
  return t ? JSON.parse(t) : null
}

/* =============== Revisiones (cada una devuelve hallazgos) =============== */
// h = { clave, robot, pc?, centro?, severidad: 'alta'|'media', titulo, detalle }

async function revisarRobots() {
  const filas = await q(KK, 'robot_status?select=robot,pc,centro,estado,detalle,ultimo_error,intervalo_seg,last_seen')
  const out = []
  for (const s of filas.filter((f) => f.robot !== 'jefe')) {
    const n = NOMBRES[s.robot] || s.robot
    const limite = (s.intervalo_seg || 180) * 2 + 90
    const edad = (Date.now() - new Date(s.last_seen).getTime()) / 1000
    const m = minEnHorario(s.robot)
    if (edad > limite && m !== null && m * 60 >= limite)
      out.push({ clave: `caido:${s.robot}|${s.pc}`, robot: s.robot, pc: s.pc, centro: s.centro, severidad: 'alta',
        titulo: `${n} no reporta desde las ${horaGT(s.last_seen)}`,
        detalle: `PC ${s.pc}. Debería reportar cada ${Math.round((s.intervalo_seg || 180) / 60)} min. Revisar que la PC esté encendida, con sesión y que la tarea programada esté corriendo.` })
    else if (s.estado === 'error')
      out.push({ clave: `error:${s.robot}|${s.pc}`, robot: s.robot, pc: s.pc, centro: s.centro, severidad: 'alta',
        titulo: `${n} terminó con error`, detalle: corto(s.ultimo_error || s.detalle, 500) })
  }
  return out
}

async function revisarCitas() {
  const out = []
  const revisar = await q(KK, 'cita_equipos?select=orden,external_id,sync_error,citas!inner(numero)&sync_status=eq.needs_review&limit=50')
  if (revisar.length) out.push({ clave: 'citas:revisar', robot: 'citas', severidad: 'media',
    titulo: `${revisar.length} equipo(s) de citas para revisar a mano`,
    detalle: revisar.slice(0, 10).map((e) => `Cita ${e.citas.numero}-${e.orden}${e.external_id ? ` (${e.external_id})` : ''}: ${corto(e.sync_error, 120)}`).join(' · ') })
  const lim = MIN('CITAS_ATORADA_MIN', 30)
  if (minEnHorario('citas') !== null) {
    const atoradas = await q(KK, `cita_equipos?select=orden,citas!inner(numero)&sync_status=eq.listo&external_id=is.null&revisado_at=lt.${haceMin(lim)}&limit=50`)
    if (atoradas.length) out.push({ clave: 'citas:atoradas', robot: 'citas', severidad: 'alta',
      titulo: `${atoradas.length} cita(s) lista(s) sin llamada hace más de ${lim} min`,
      detalle: `El robot de Citas no las está tomando: ${atoradas.slice(0, 10).map((e) => `${e.citas.numero}-${e.orden}`).join(', ')}` })
  }
  const rechazadas = await q(KK, `cita_equipos?select=orden,sync_error,citas!inner(numero)&sync_status=eq.rejected&last_sync_attempt_at=gte.${haceMin(24 * 60)}&limit=50`)
  if (rechazadas.length) out.push({ clave: 'citas:rechazadas', robot: 'citas', severidad: 'alta',
    titulo: `${rechazadas.length} equipo(s) de citas rechazados (3 intentos fallidos) en 24 h`,
    detalle: rechazadas.slice(0, 10).map((e) => `Cita ${e.citas.numero}-${e.orden}: ${corto(e.sync_error, 120)}`).join(' · ') })
  return out
}

async function revisarCorreos() {
  const out = []
  const errores = await q(CC, 'correos_cola?select=tipo,referencia,ultimo_error&estado=eq.error&order=created_at.desc&limit=50')
  if (errores.length) out.push({ clave: 'correos:error', robot: 'correos', severidad: 'alta',
    titulo: `${errores.length} correo(s) que no se pudieron enviar`,
    detalle: errores.slice(0, 10).map((c) => `${c.tipo} ${c.referencia || ''}: ${corto(c.ultimo_error, 100)}`).join(' · ') })
  const lim = MIN('CORREO_ATRASADO_MIN', 15)
  if (minEnHorario('correos') !== null) {
    const atrasados = await q(CC, `correos_cola?select=tipo,referencia&estado=in.(pendiente,enviando)&created_at=lt.${haceMin(lim)}&limit=50`)
    if (atrasados.length) out.push({ clave: 'correos:atrasados', robot: 'correos', severidad: 'media',
      titulo: `${atrasados.length} correo(s) en cola hace más de ${lim} min`,
      detalle: atrasados.slice(0, 10).map((c) => `${c.tipo} ${c.referencia || ''}`).join(' · ') })
  }
  return out
}

async function revisarDigitadores() {
  const out = []
  const pend = await q(CC, `llamadas_actualizaciones?select=num_llamada,pendiente_motivo&pendiente_por=eq.${encodeURIComponent(ROBOT_DIG)}&digitado_en=is.null&limit=50`)
  if (pend.length) out.push({ clave: 'digitadores:pendientes', robot: 'digitadores', severidad: 'media',
    titulo: `${pend.length} llamada(s) que el robot dejó pendientes`,
    detalle: pend.slice(0, 10).map((a) => `${a.num_llamada}: ${corto(a.pendiente_motivo, 100)}`).join(' · ') })
  const cfg = await q(CC, 'etiquetera_config?select=valor&clave=eq.robot_garantia_activo')
  const activo = cfg?.[0]?.valor === true
  if (activo && minEnHorario('digitadores') !== null) {
    const est = await q(CC, 'llamadas_estados?select=id,nombre')
    const gar = est.find((e) => /^garant[ií]a$/i.test(e.nombre.trim()))
    const lim = MIN('GARANTIA_SIN_TOMAR_MIN', 60)
    if (gar) {
      const viejas = await q(CC, `llamadas_actualizaciones?select=num_llamada,created_at&estado_id=eq.${gar.id}&digitado_en=is.null&garantia_id=is.null&pendiente_en=is.null&tomado_por=is.null&created_at=lt.${haceMin(lim)}&limit=50`)
      if (viejas.length) out.push({ clave: 'digitadores:sin_tomar', robot: 'digitadores', severidad: 'alta',
        titulo: `${viejas.length} llamada(s) de Garantía esperando más de ${lim} min`,
        detalle: `Nadie las ha tomado: ${viejas.slice(0, 10).map((a) => a.num_llamada).join(', ')}` })
    }
  }
  return out
}

const REVISIONES = { robots: revisarRobots, citas: revisarCitas, correos: revisarCorreos, digitadores: revisarDigitadores }

/* =============== Hallazgos: abrir / actualizar / cerrar =============== */
async function avisar(h, abierto) {
  if (!PROD || !ALERTAR_A.length || h.severidad !== 'alta') return false
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#111827">
    <div style="background:#b91c1c;color:#fff;padding:10px 16px;font-weight:600">JEFE DEL DUNGEON · ALERTA</div>
    <div style="padding:16px"><h3 style="margin:0 0 10px">${esc(h.titulo)}</h3>
    <p style="margin:0 0 10px">${esc(h.detalle || '')}</p>
    <p style="margin:0;color:#6b7280;font-size:12px">Robot: ${esc(NOMBRES[h.robot] || h.robot || '—')}${h.pc ? ' · PC ' + esc(h.pc) : ''} · detectado ${esc(horaGT(abierto))}<br>
    <a href="https://hpc-robots-monitor.vercel.app/">Ver el dungeon</a></p></div></div>`
  await q(CC, 'correos_cola?on_conflict=clave', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal', body: {
    tipo: 'jefe_alerta', para: ALERTAR_A, asunto: `[Jefe] ${h.titulo}`, html, referencia: h.robot || 'jefe', clave: `jefe:${h.clave}:${abierto}`,
  } })
  return true
}

async function main() {
  log(`=== Jefe · ${PROD ? 'PROD' : 'QA (solo muestra)'} ===`)
  mon.trabajando(null, 'Revisando a los robots')
  const encontrados = [], revisadas = [], fallas = []
  for (const [nombre, fn] of Object.entries(REVISIONES)) {
    try { encontrados.push(...await fn()); revisadas.push(nombre) }
    catch (e) {
      fallas.push(nombre)
      encontrados.push({ clave: `jefe:revision:${nombre}`, robot: 'jefe', severidad: 'media', titulo: `El Jefe no pudo revisar ${nombre}`, detalle: corto(e, 400) })
    }
  }
  encontrados.forEach((h) => log(`${h.severidad === 'alta' ? 'ALTA ' : 'MEDIA'} ${h.titulo} — ${h.detalle || ''}`))
  if (!encontrados.length) log('Todo en orden.')
  if (!PROD) return

  const abiertos = await q(KK, 'jefe_hallazgos?select=id,clave,abierto_en,avisado_en&cerrado_en=is.null')
  const ahora = new Date().toISOString()
  for (const h of encontrados) {
    const ya = abiertos.find((a) => a.clave === h.clave)
    const datos = { robot: h.robot || null, pc: h.pc || null, centro: h.centro || null, severidad: h.severidad, titulo: h.titulo, detalle: h.detalle || null, ultimo_visto: ahora }
    if (ya) {
      if (!ya.avisado_en && await avisar(h, ya.abierto_en).catch(() => false)) datos.avisado_en = ahora
      await q(KK, `jefe_hallazgos?id=eq.${ya.id}`, { method: 'PATCH', body: datos, prefer: 'return=minimal' })
    } else {
      const avisado = await avisar(h, ahora).catch((e) => { log(`No se pudo encolar el correo: ${corto(e)}`); return false })
      await q(KK, 'jefe_hallazgos', { method: 'POST', prefer: 'return=minimal', body: { ...datos, clave: h.clave, abierto_en: ahora, ...(avisado ? { avisado_en: ahora } : {}) } })
      mon.revisar(null, `Nuevo: ${h.titulo}`)
      log(`ABIERTO ${h.clave}${avisado ? ' (correo encolado)' : ''}`)
    }
  }
  // se cierran solo los que ya no aparecen Y cuya revisión sí corrió (si una revisión falló, no se cierra lo suyo)
  const prefijo = (c) => c.startsWith('caido:') || c.startsWith('error:') ? 'robots' : c.startsWith('jefe:revision:') ? c.split(':')[2] : c.split(':')[0]
  for (const a of abiertos) {
    if (encontrados.some((h) => h.clave === a.clave)) continue
    const rev = prefijo(a.clave)
    if (!a.clave.startsWith('jefe:revision:') && !revisadas.includes(rev)) continue
    await q(KK, `jefe_hallazgos?id=eq.${a.id}`, { method: 'PATCH', body: { cerrado_en: ahora }, prefer: 'return=minimal' })
    mon.ok(null, `Resuelto: ${a.clave}`)
    log(`CERRADO ${a.clave}`)
  }
  const altos = encontrados.filter((h) => h.severidad === 'alta').length
  mon.fin(encontrados.length ? `${encontrados.length} hallazgo(s) abiertos${altos ? ` · ${altos} alto(s)` : ''}` : 'Todo en orden')
}

main()
  .catch((e) => { log(`ERROR ${corto(e)}`); mon.error(e); process.exitCode = 1 })
  .finally(() => mon.flush())

/**
 * El Jefe del dungeon — audita el trabajo de los robots y:
 *   · abre / actualiza / cierra hallazgos en jefe_hallazgos (kkzo) → el dungeon lo muestra
 *   · da ÓRDENES seguras a los robots (jefe_ordenes en ConsumosCS): hoy, cambiar SKU si es la misma familia
 *   · avisa por correo (cola del robot de Correos) solo lo delicado (hallazgos ALTOS)
 *   · en CSHP solo LEE (cshp.mjs): nunca modifica, cambia status ni acepta nada
 *   npm.cmd run revisar   (QA: solo imprime lo que encontró)
 *   npm.cmd run prod      (guarda, reporta y avisa)
 */
import { crearMonitor } from '../shared/monitor.mjs'
import { mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { abrirCSHP, cerrarCSHP, leerLlamada, cshpResponde, pendientesGuias } from './cshp.mjs'

const E = process.env, args = process.argv.slice(2)
const PROD = args.includes('--prod') || (!args.includes('--qa') && /^prod/i.test(E.AMBIENTE || ''))
const KK = { nombre: 'kkzo', url: (E.KKZO_URL || '').replace(/\/$/, ''), key: E.KKZO_SERVICE_ROLE_KEY || '' }
const CC = { nombre: 'ConsumosCS', url: (E.CONSUMOS_URL || '').replace(/\/$/, ''), key: E.CONSUMOS_SERVICE_ROLE_KEY || '' }
const ALERTAR_A = String(E.ALERTAR_A || '').split(',').map((x) => x.trim()).filter(Boolean)
const ROBOT_DIG = (E.DIGITADORES_ROBOT || 'robot-digitadores').trim().toLowerCase()
const MIN = (k, d) => Number(E[k] || d)
const CSHP = { base: (E.CSHP_PROD_URL || E.CSHP_URL || '').replace(/\/(Login\.aspx)?$/i, ''), usuario: E.CSHP_PROD_USUARIO || E.CSHP_USUARIO, password: E.CSHP_PROD_PASSWORD || E.CSHP_PASSWORD }
const MAX_AUDITAR = Number(E.MAX_AUDITAR || 10)   // llamadas que abre en CSHP por corrida
const AUDITAR_DESDE = (E.AUDITAR_DESDE || '').trim()   // solo se auditan llamadas digitadas desde esta fecha (ISO)
const normalizar = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
let cshpCaido = null   // si CSHP no responde, los errores de los robots no se mandan por correo (se avisa una sola vez)
const CARGA = {}       // pendientes reales por robot: { citas: { n, detalle }, ... } (n = null si no se pudo revisar)
/* Una sola sesión de CSHP por corrida (se abre solo si hace falta) */
let sesion = null
async function sesionCSHP() { if (!sesion) sesion = await abrirCSHP(CSHP); return sesion }
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
  const filas = await q(KK, 'robot_status?select=*')
  const out = []
  for (const s of filas.filter((f) => f.robot !== 'jefe')) {
    const n = NOMBRES[s.robot] || s.robot
    const limite = (s.intervalo_seg || 180) * 2 + 90
    const edad = (Date.now() - new Date(s.last_seen).getTime()) / 1000
    const m = minEnHorario(s.robot)
    const carga = CARGA[s.robot]
    if (edad > limite && m !== null && m * 60 >= limite) {
      if (carga && carga.n === 0) { log(`OK ${n} sin reportar desde ${horaGT(s.last_seen)}, pero sin pendientes (${carga.detalle})`); continue }
      out.push({ clave: `caido:${s.robot}|${s.pc}`, robot: s.robot, pc: s.pc, centro: s.centro, severidad: 'alta',
        titulo: carga?.n ? `${n} no reporta y tiene ${carga.n} pendiente(s)` : `${n} no reporta desde las ${horaGT(s.last_seen)}`,
        detalle: `${carga?.n ? carga.detalle + '. ' : ''}PC ${s.pc}, último reporte ${horaGT(s.last_seen)} (debería cada ${Math.round((s.intervalo_seg || 180) / 60)} min). Revisar que la PC esté encendida, con sesión y que la tarea programada esté corriendo.` })
    }
    else if (s.estado === 'error')
      out.push({ clave: `error:${s.robot}|${s.pc}`, robot: s.robot, pc: s.pc, centro: s.centro, severidad: 'alta',
        titulo: `${n} terminó con error`, detalle: corto(s.ultimo_error || s.detalle, 500) })
  }
  const caidos = out.filter((h) => h.clave.startsWith('caido:') || h.clave.startsWith('error:'))
  if (caidos.length >= 2) {
    const r = await cshpResponde(CSHP.base)
    if (!r.ok) cshpCaido = r
    out.push({ clave: 'robots:varios', robot: 'jefe', severidad: r.ok ? 'alta' : 'media',
      titulo: r.ok ? `${caidos.length} robots fallando a la vez (CSHP sí responde)` : `${caidos.length} robots fallando: parece ser CSHP`,
      detalle: `${caidos.map((h) => NOMBRES[h.robot] || h.robot).join(', ')}. ${r.ok ? `CSHP respondió en ${r.ms} ms: revisar red/PCs.` : `CSHP no responde (${r.detalle}).`}` })
  }
  return out
}

async function revisarCitas() {
  const out = []
  // Error al crear la llamada (en cualquier intento): needs_review, rechazada, o "listo" con error de un intento anterior
  const conError = await q(KK, `cita_equipos?select=orden,external_id,sync_error,sync_status,sync_retries,citas!inner(numero)&sync_error=not.is.null&sync_status=in.(listo,needs_review,rejected)&or=(sync_status.neq.rejected,last_sync_attempt_at.gte.${haceMin(7 * 24 * 60)})&limit=50`)
  if (conError.length) out.push({ clave: 'citas:error', robot: 'citas', severidad: 'alta',
    titulo: `${conError.length} equipo(s) de citas con error al crear la llamada`,
    detalle: conError.slice(0, 10).map((e) => `Cita ${e.citas.numero}-${e.orden}${e.external_id ? ` (${e.external_id})` : ''} [${e.sync_status === 'listo' ? `reintentando ${e.sync_retries}/3` : e.sync_status === 'rejected' ? 'rechazada' : 'revisar a mano'}]: ${corto(e.sync_error, 120)}`).join(' · ') })
  const lim = MIN('CITAS_ATORADA_MIN', 30)
  if (minEnHorario('citas') !== null) {
    const atoradas = await q(KK, `cita_equipos?select=orden,citas!inner(numero)&sync_status=eq.listo&external_id=is.null&revisado_at=lt.${haceMin(lim)}&limit=50`)
    if (atoradas.length) out.push({ clave: 'citas:atoradas', robot: 'citas', severidad: 'alta',
      titulo: `${atoradas.length} cita(s) lista(s) sin llamada hace más de ${lim} min`,
      detalle: `El robot de Citas no las está tomando: ${atoradas.slice(0, 10).map((e) => `${e.citas.numero}-${e.orden}`).join(', ')}` })
  }
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
  const pend = (await q(CC, `llamadas_actualizaciones?select=num_llamada,pendiente_motivo&pendiente_por=eq.${encodeURIComponent(ROBOT_DIG)}&digitado_en=is.null&limit=100`))
    .filter((a) => !/^El SKU no coincide/i.test(a.pendiente_motivo || ''))
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

/* Familia y categoría de un SKU según el catálogo de la Bandeja (igual que Digitadores) */
async function categoriaDeSku(sku) {
  const r = await q(CC, `llamadas_producto_categorias?select=categoria_id,llamadas_categorias(nombre,familia)&sku=eq.${encodeURIComponent(String(sku).trim())}&limit=1`)
  const d = r?.[0]; if (!d) return null
  return { id: d.categoria_id, nombre: d.llamadas_categorias?.nombre || '', familia: d.llamadas_categorias?.familia || '' }
}
const desc = (c) => (c ? `${c.familia} · ${c.nombre}` : 'sin categoría en el catálogo')
async function revisarSku() {
  const out = []
  const pend = await q(CC, `llamadas_actualizaciones?select=num_llamada,producto_sku,pendiente_motivo&pendiente_por=eq.${encodeURIComponent(ROBOT_DIG)}&digitado_en=is.null&pendiente_motivo=ilike.El%20SKU%20no%20coincide*&limit=50`)
  if (!pend.length) return out
  const ordenes = await q(CC, `jefe_ordenes?select=num_llamada,estado,sku_nuevo&accion=eq.cambiar_sku&estado=eq.pendiente`)
  for (const a of pend) {
    const num = a.num_llamada.toUpperCase(), motivo = a.pendiente_motivo || ''
    const skuCshp = (motivo.match(/CSHP (\d+)/) || [])[1], skuForm = String(a.producto_sku || '').trim()
    if (ordenes.some((o) => o.num_llamada.toUpperCase() === num)) continue   // ya tiene orden: la ejecuta Digitadores
    const avisar = (titulo, detalle) => out.push({ clave: `sku:${num}`, robot: 'digitadores', severidad: 'alta', titulo, detalle })
    if (/ya est[aá]|facturad/i.test(motivo)) { avisar(`${num}: SKU distinto y la llamada ya está facturada`, `${corto(motivo, 300)}. El Jefe no la toca: decidir a mano.`); continue }
    if (!skuCshp || !/^\d+$/.test(skuForm)) { avisar(`${num}: SKU del formulario no es un código`, `Formulario "${skuForm}", CSHP ${skuCshp || '?'}. Revisar a mano.`); continue }
    const [cf, cc] = [await categoriaDeSku(skuForm), await categoriaDeSku(skuCshp)]
    if (!cf || !cc || !cf.familia || !cc.familia) { avisar(`${num}: SKU sin categoría en el catálogo`, `Formulario ${skuForm} (${desc(cf)}), CSHP ${skuCshp} (${desc(cc)}). Agregar al catálogo o decidir a mano.`); continue }
    if (normalizar(cf.familia) !== normalizar(cc.familia)) { avisar(`${num}: SKU de otra familia`, `Formulario ${skuForm} (${desc(cf)}) vs CSHP ${skuCshp} (${desc(cc)}). Producto distinto: confirmar con el técnico.`); continue }
    // Misma familia → orden a Digitadores
    out.push({ orden: { num_llamada: num, accion: 'cambiar_sku', sku_nuevo: skuForm, sku_cshp: skuCshp, motivo: `Misma familia ${cf.familia}: ${desc(cc)} → ${desc(cf)}` } })
  }
  return out
}

/* LLM21 / LLS digitadas: ¿pasaron (o no) a Logística - Envío como debían? — se revisa en CSHP (solo lectura) */
const AUD = 'auditadas.json'
const leerAud = () => { try { return JSON.parse(readFileSync(AUD, 'utf8')) } catch { return {} } }
const debeLogistica = (l) => {
  const esLLS = /^LLS/i.test(l.numero), envio = /^ENV[IÍ]O\b/i.test(l.guiaRecep)
  const cemaco = /CEMACO/i.test(l.cliente), ope = /\bOPE-\d/i.test(l.comentario)
  return { debe: esLLS || envio || (cemaco && ope), dudosa: !esLLS && !envio && cemaco !== ope, razon: esLLS ? 'LLS' : envio ? `guía de recepción "${l.guiaRecep}"` : cemaco && ope ? 'Cemaco con OPE-' : cemaco ? 'cliente Cemaco SIN OPE-' : ope ? 'OPE- pero cliente no es Cemaco' : 'ni envío ni Cemaco' }
}
async function revisarCshp() {
  const out = []
  if (!CSHP.base || !CSHP.usuario) throw new Error('Faltan CSHP_PROD_URL / CSHP_PROD_USUARIO / CSHP_PROD_PASSWORD en .env')
  const r = await cshpResponde(CSHP.base)
  if (!r.ok) { cshpCaido = r; out.push({ clave: 'cshp:caido', robot: 'jefe', severidad: 'alta', titulo: 'CSHP no responde', detalle: `${CSHP.base} · ${r.detalle} (${r.ms} ms). Los robots que usan CSHP van a fallar hasta que vuelva.` }); return out }
  const aud = leerAud()
  // digitadas por el robot en los últimos 2 días
  const evs = await q(KK, `robot_eventos?select=llamada,mensaje,created_at&robot=eq.digitadores&tipo=eq.ok&llamada=not.is.null&created_at=gte.${[haceMin(2 * 24 * 60), AUDITAR_DESDE].filter(Boolean).sort().pop()}&created_at=lt.${haceMin(2)}&order=created_at&limit=500`)
  const robotLaPaso = new Map(evs.map((e) => [e.llamada.toUpperCase(), /log[ií]stica/i.test(e.mensaje || '')]))
  const porRevisar = [...new Set(evs.filter((e) => /DIGITADA/i.test(e.mensaje || '')).map((e) => e.llamada.toUpperCase()))]
    .filter((n) => !aud[n] || aud[n].estado === 'alerta')
    .sort((a, b) => (aud[a]?.estado === 'alerta' ? 1 : 0) - (aud[b]?.estado === 'alerta' ? 1 : 0))
    .slice(0, MAX_AUDITAR)
  if (porRevisar.length) {
    let cshp = null
    try {
      cshp = await sesionCSHP()
      for (const n of porRevisar) {
        try {
          const l = await leerLlamada(cshp, n), d = debeLogistica(l)
          const ok = d.debe === l.pasoPorLogistica && !d.dudosa
          aud[n] = { estado: ok ? 'ok' : 'alerta', revisada: new Date().toISOString(), debe: d.debe, paso: l.pasoPorLogistica, status: l.statusActual, razon: d.razon,
            robot: robotLaPaso.get(n) || false, logistica: l.logistica, campos: `guía recep. "${l.guiaRecep || '—'}" · cliente "${corto(l.cliente, 40) || '—'}" · comentario "${corto(l.comentario, 60) || '—'}"` }
          log(`AUDITADA ${n}: ${ok ? 'OK' : 'ALERTA'} · ${d.razon} · status ${l.statusActual}${l.pasoPorLogistica ? ' · pasó por Logística' : ''}`)
        } catch (e) { log(`No se pudo auditar ${n}: ${corto(e)}`) }
      }
    } catch (e) {
      if (/Cannot find (package|module) 'playwright'/i.test(String(e))) {
        out.push({ clave: 'jefe:revision:cshp', robot: 'jefe', severidad: 'media', titulo: 'Falta instalar Playwright en la carpeta jefe', detalle: 'Correr npm.cmd install en C:\\Users\\jcotuc\\source\\repos\\hpc-robots\\jefe' })
      } else {
        cshpCaido = { detalle: corto(e) }
        out.push({ clave: 'cshp:caido', robot: 'jefe', severidad: 'alta', titulo: 'El Jefe no pudo entrar a CSHP', detalle: corto(e, 300) })
      }
    }
    if (PROD) writeFileSync(AUD, JSON.stringify(aud, null, 1))
  }
  // hallazgos de todas las que siguen en alerta (se cierran cuando una nueva revisión sale bien)
  for (const [n, a] of Object.entries(aud)) {
    if (a.estado !== 'alerta') continue
    const titulo = a.debe && !a.paso ? `${n} debía pasar a Logística - Envío y quedó en "${a.status}"`
      : !a.debe && a.paso ? (a.robot ? `${n}: el robot la pasó a Logística - Envío sin ser envío ni Cemaco`
                                     : `${n}: Digitadores la dejó en Facturación, pero alguien la pasó a Logística - Envío`)
      : `${n}: señal de Cemaco incompleta (${a.razon})`
    const porque = !a.debe && a.paso && !a.robot ? ' ¿Es un envío que el robot no reconoce (falta una regla) o se movió por error?' : ''
    out.push({ clave: `llm:${n}`, robot: 'digitadores', severidad: a.debe !== a.paso ? 'alta' : 'media', titulo,
      detalle: `CSHP ${horaGT(a.revisada)}: ${a.campos || a.razon}. Status: ${a.status || '?'}.${a.logistica ? ` Cambio a Logística: ${a.logistica}.` : ''}${porque}` })
  }
  // limpiar auditadas viejas (> 7 días)
  for (const [n, a] of Object.entries(aud)) if (a.estado === 'ok' && Date.now() - new Date(a.revisada).getTime() > 7 * 86400000) delete aud[n]
  return out
}

async function revisarCarga() {
  const intenta = async (robot, fn) => { try { CARGA[robot] = await fn() } catch (e) { CARGA[robot] = { n: null, detalle: `No se pudo revisar: ${corto(e, 150)}` } } }
  await intenta('citas', async () => {
    const r = await q(KK, 'cita_equipos?select=orden,citas!inner(numero)&sync_status=eq.listo&external_id=is.null&limit=200')
    return { n: r.length, detalle: r.length ? `${r.length} equipo(s) de cita listos para crear llamada` : 'Sin citas por procesar' }
  })
  await intenta('correos', async () => {
    const r = await q(CC, 'correos_cola?select=id&estado=in.(pendiente,enviando)&limit=500')
    return { n: r.length, detalle: r.length ? `${r.length} correo(s) en cola` : 'Sin correos en cola' }
  })
  await intenta('digitadores', async () => {
    const cfg = await q(CC, 'etiquetera_config?select=valor&clave=eq.robot_garantia_activo')
    if (cfg?.[0]?.valor !== true) return { n: 0, detalle: 'Robot apagado en Administración' }
    const est = await q(CC, 'llamadas_estados?select=id,nombre'), gar = est.find((e) => /^garant[ií]a$/i.test(e.nombre.trim()))
    if (!gar) return { n: null, detalle: 'No existe el estado Garantía' }
    const r = await q(CC, `llamadas_actualizaciones?select=num_llamada&estado_id=eq.${gar.id}&digitado_en=is.null&garantia_id=is.null&pendiente_en=is.null&limit=200`)
    return { n: r.length, detalle: r.length ? `${r.length} llamada(s) de Garantía en la Bandeja` : 'Sin Garantías en la Bandeja' }
  })
  await intenta('guias', async () => {
    if (minEnHorario('guias') === null) return { n: null, detalle: 'Fuera de horario: no se revisó CSHP' }
    if (cshpCaido) return { n: null, detalle: 'CSHP no responde: no se pudo revisar' }
    const lista = await pendientesGuias(await sesionCSHP(), { centro: E.GUIAS_CENTRO || 'HPCS016', status: E.GUIAS_STATUS || '106' })
    return { n: lista.length, detalle: lista.length ? `${lista.length} LLS en 106 por imprimir: ${lista.slice(0, 5).join(', ')}` : 'Sin LLS en 106 por imprimir' }
  })
  Object.entries(CARGA).forEach(([r, c]) => log(`CARGA ${r}: ${c.n ?? '?'} · ${c.detalle}`))
  if (PROD) await q(KK, 'robot_carga?on_conflict=robot', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
    body: Object.entries(CARGA).map(([robot, c]) => ({ robot, pendientes: c.n, detalle: c.detalle, revisado_en: new Date().toISOString() })) })
  return []
}

const REVISIONES = { cshp: revisarCshp, carga: revisarCarga, robots: revisarRobots, citas: revisarCitas, correos: revisarCorreos, digitadores: revisarDigitadores, sku: revisarSku }

/* =============== Hallazgos: abrir / actualizar / cerrar =============== */
async function avisar(h, abierto) {
  if (!PROD || !ALERTAR_A.length || h.severidad !== 'alta') return false
  if (cshpCaido && /^(error|caido):/.test(h.clave)) return false   // ya se avisó 'CSHP no responde'
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
  const ordenes = encontrados.filter((x) => x.orden).map((x) => x.orden)
  encontrados.splice(0, encontrados.length, ...encontrados.filter((x) => !x.orden))
  ordenes.forEach((o) => log(`ORDEN ${o.accion} ${o.num_llamada}: ${o.sku_cshp} → ${o.sku_nuevo} (${o.motivo})`))
  encontrados.forEach((h) => log(`${h.severidad === 'alta' ? 'ALTA ' : 'MEDIA'} ${h.titulo} — ${h.detalle || ''}`))
  if (!encontrados.length && !ordenes.length) log('Todo en orden.')
  if (!PROD) return
  for (const o of ordenes) {
    try {
      await q(CC, 'jefe_ordenes', { method: 'POST', prefer: 'return=minimal', body: o })
      mon.ok(o.num_llamada, `Orden: cambiar SKU ${o.sku_cshp} → ${o.sku_nuevo} · ${o.motivo}`)
    } catch (e) { if (!/duplicate|23505/.test(String(e))) log(`No se pudo crear la orden ${o.num_llamada}: ${corto(e)}`) }
  }

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
  const REV = { caido: 'robots', error: 'robots', robots: 'robots', citas: 'citas', correos: 'correos', digitadores: 'digitadores', sku: 'sku', llm: 'cshp', cshp: 'cshp' }
  const prefijo = (c) => c.startsWith('jefe:revision:') ? c.split(':')[2] : REV[c.split(':')[0]] || c.split(':')[0]
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
  .finally(async () => { await cerrarCSHP(sesion); await mon.flush() })

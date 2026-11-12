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
import { investigar, recordar } from './investigar.mjs'

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
const mon = crearMonitor('jefe', { intervaloSeg: 180, activo: PROD })

/* Horario de cada robot (igual que su programar-tarea.cmd) para no alarmar fuera de turno */
const LS = [1, 2, 3, 4, 5, 6]
const HORARIOS = {
  citas: { dias: LS, desde: '06:00', hasta: '22:00' }, guias: { dias: LS, desde: '07:00', hasta: '20:00' },
  digitadores: { dias: LS, desde: '06:00', hasta: '22:00' }, correos: { dias: LS, desde: '07:00', hasta: '20:00' },
}
const NOMBRES = { citas: 'Citas', guias: 'Guías', digitadores: 'Digitadores', correos: 'Correos', garantias: 'Garantías', truper: 'Catálogo Truper' }
/* Robots que se corren a mano: si no reportan no es falla; solo importa si tienen pendientes esperando */
const MANUALES = ['garantias', 'truper']   // truper: corre solo el día 1 de cada mes (ver revisarTruper)
const GARANTIA_ESPERA_MIN = Number(E.GARANTIA_ESPERA_MIN || 60)

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

/* Nombre del centro en la Bandeja (ConsumosCS) → nivel del dungeon. Igual que en digitadores/digitar-garantia.mjs */
// Nombre del centro en la Bandeja → nivel del dungeon. Corrige errores de dedo ("El aRancho", "ElRancho" → "El Rancho")
const CENTROS_DUNGEON = ['Nodus', 'Zona 4', 'Chimaltenango', 'Quiché', 'Escuintla', 'Río Hondo', 'Xela', 'Cobán', 'Huehuetenango', 'Mazatenango', 'Petén', 'Jutiapa', 'El Rancho', 'Morales']
const ALIAS_CENTRO = { zona6: 'Nodus', nodus: 'Nodus', quetzaltenango: 'Xela' }
const claveCentro = (n) => String(n ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')
function distCentro(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}
const centroDungeon = (n) => {
  const k = claveCentro(n); if (!k) return 'Nodus'
  if (ALIAS_CENTRO[k]) return ALIAS_CENTRO[k]
  const num = (x) => x.replace(/\D/g, '')   // "Zona 18" nunca es "Zona 4"
  const m = CENTROS_DUNGEON.filter((c) => num(claveCentro(c)) === num(k)).map((c) => ({ c, d: distCentro(k, claveCentro(c)) })).sort((a, b) => a.d - b.d)[0] || { d: 99 }
  return m.d <= (k.length >= 6 ? 2 : 1) ? m.c : String(n).trim()   // centro nuevo de verdad: se queda con su nombre
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
    const carga = CARGA[`${s.robot}@${s.centro}`] ?? CARGA[s.robot]   // digitadores: carga de su centro
    if (MANUALES.includes(s.robot)) continue          // manual: ver revisarGarantias
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
    // Además de la carga total, una por centro (digitadores@Nodus, digitadores@Zona 4…): el dungeon tiene un digitador por centro
    const centros = (await q(CC, 'llamadas_centros?select=nombre').catch(() => [])).map((c) => centroDungeon(c.nombre))
    const porCentro = (lista, vacio) => centros.forEach((c) => {
      const n = lista ? lista.filter((x) => centroDungeon(x.llamadas_centros?.nombre) === c).length : 0
      CARGA[`digitadores@${c}`] = { n, detalle: n ? `${n} llamada(s) de Garantía en la Bandeja (${c})` : vacio }
    })
    const cfg = await q(CC, 'etiquetera_config?select=valor&clave=eq.robot_garantia_activo')
    if (cfg?.[0]?.valor !== true) { porCentro(null, 'Robot apagado en Administración'); return { n: 0, detalle: 'Robot apagado en Administración' } }
    const est = await q(CC, 'llamadas_estados?select=id,nombre'), gar = est.find((e) => /^garant[ií]a$/i.test(e.nombre.trim()))
    if (!gar) return { n: null, detalle: 'No existe el estado Garantía' }
    const r = await q(CC, `llamadas_actualizaciones?select=num_llamada,llamadas_centros(nombre)&estado_id=eq.${gar.id}&digitado_en=is.null&garantia_id=is.null&pendiente_en=is.null&limit=200`)
    porCentro(r, 'Sin Garantías en la Bandeja')
    return { n: r.length, detalle: r.length ? `${r.length} llamada(s) de Garantía en la Bandeja` : 'Sin Garantías en la Bandeja' }
  })
  await intenta('garantias', async () => {
    const r = await q(KK, 'garantias_manuales?select=id,created_at&sync_status=eq.pending&record_status=eq.NDC&deleted=eq.false&limit=200')
    // hechas hoy según la BASE (no depende de que el robot reporte al monitor): llamada creada en CSHP hoy
    const inicio = new Date(`${fechaGT()}T00:00:00-06:00`).toISOString()
    const h = await q(KK, `garantias_manuales?select=last_sync_attempt_at&sync_status=in.(synced,status_updated)&deleted=eq.false&last_sync_attempt_at=gte.${inicio}&order=last_sync_attempt_at.desc&limit=2000`)
    return { n: r.length, detalle: r.length ? `${r.length} NDC por sincronizar (se corre a mano)` : 'Sin NDC pendientes', masVieja: r.map((x) => x.created_at).sort()[0],
      hoy: h.length, ultima: h[0]?.last_sync_attempt_at || null }
  })
  await intenta('truper', async () => {
    // Catálogo Truper (mensual): pendiente = 1 mientras no se haya descargado el catálogo de este mes
    const s = (await q(KK, 'robot_status?select=estado,detalle,last_seen&robot=eq.truper'))[0]
    const mes = fechaGT().slice(0, 7), mesDe = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' }).slice(0, 7)
    if (s?.estado === 'trabajando' && Date.now() - new Date(s.last_seen).getTime() < TRUPER_DETENIDO_MIN * 60000) return { n: 1, detalle: `Descargando: ${s.detalle || ''}` }
    if (s?.estado === 'esperando' && mesDe(s.last_seen) === mes) return { n: 0, detalle: `Catálogo de ${mes} descargado` }
    return { n: 1, detalle: `Falta descargar el catálogo de ${mes} (tarea "HPC Truper", día 1 a las 2:00)` }
  })
  await intenta('guias', async () => {
    if (minEnHorario('guias') === null) return { n: null, detalle: 'Fuera de horario: no se revisó CSHP' }
    if (cshpCaido) return { n: null, detalle: 'CSHP no responde: no se pudo revisar' }
    const lista = await pendientesGuias(await sesionCSHP(), { centro: E.GUIAS_CENTRO || 'HPCS016', status: E.GUIAS_STATUS || '106' })
    return { n: lista.length, detalle: lista.length ? `${lista.length} LLS en 106 por imprimir: ${lista.slice(0, 5).join(', ')}` : 'Sin LLS en 106 por imprimir' }
  })
  Object.entries(CARGA).forEach(([r, c]) => log(`CARGA ${r}: ${c.n ?? '?'} · ${c.detalle}`))
  if (PROD) {
    const filas = Object.entries(CARGA).map(([robot, c]) => ({ robot, pendientes: c.n, detalle: c.detalle, revisado_en: new Date().toISOString(), hoy: c.hoy ?? null, ultima: c.ultima ?? null }))
    const subir = (body) => q(KK, 'robot_carga?on_conflict=robot', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body })
    // si todavía no se corrió monitor/08_carga_hoy.sql (columnas hoy/ultima), se sube sin ellas
    await subir(filas).catch(() => subir(filas.map(({ hoy, ultima, ...f }) => f)))
  }
  return []
}

/* Catálogo Truper (mensual): nada es delicado → todo en severidad media (no manda correo) */
const TRUPER_DETENIDO_MIN = Number(E.TRUPER_DETENIDO_MIN || 30)
async function revisarTruper() {
  const s = (await q(KK, 'robot_status?select=*&robot=eq.truper'))[0]
  const base = { robot: 'truper', pc: s?.pc, centro: s?.centro, severidad: 'media' }
  const edadMin = s ? (Date.now() - new Date(s.last_seen).getTime()) / 60000 : Infinity
  if (s?.estado === 'trabajando' && edadMin >= TRUPER_DETENIDO_MIN)
    return [{ ...base, clave: 'truper:detenido', titulo: 'Catálogo Truper se detuvo a medias',
      detalle: `Último avance a las ${horaGT(s.last_seen)}: ${s.detalle || '—'}. La PC ${s.pc} se apagó, suspendió o se cerró la corrida. Correr truper\\correr.cmd: retoma donde iba.` }]
  if (s?.estado === 'error')
    return [{ ...base, clave: 'truper:error', titulo: 'Catálogo Truper terminó con error',
      detalle: `${corto(s.ultimo_error || s.detalle, 400)}. Volver a correr truper\\correr.cmd (reintenta solo lo que falló); si se repite, Truper cambió su sitio.` }]
  if (CARGA.truper?.n && !/^Descargando/.test(CARGA.truper.detalle) && +fechaGT().slice(8) >= 3)
    return [{ ...base, clave: 'truper:pendiente', titulo: 'Falta descargar el catálogo Truper de este mes', detalle: `${CARGA.truper.detalle}. Revisar que la tarea exista en la PC o correr truper\\correr.cmd.` }]
  return []
}

/* Garantías (manual): errores al crear la NC → alto; NDC esperando mucho a que alguien corra el robot → medio */
async function revisarGarantias() {
  const out = []
  // el filtro de estado va aquí (no en la URL): el enum de la app no tiene todos los valores (p. ej. 'rejected')
  const mal = (await q(KK, `garantias_manuales?select=id,codigo_cliente,external_id,sync_status,sync_retries&deleted=eq.false&last_sync_attempt_at=gte.${haceMin(7 * 24 * 60)}&limit=500`))
    .filter((g) => ['rejected', 'needs_review', 'duplicated'].includes(g.sync_status)).slice(0, 50)
  if (mal.length) out.push({ clave: 'garantias:error', robot: 'garantias', severidad: 'alta',
    titulo: `${mal.length} garantía(s) NDC con problema al crear la llamada`,
    detalle: mal.slice(0, 10).map((g) => `Cliente ${g.codigo_cliente}${g.external_id ? ` (${g.external_id})` : ''}: ${g.sync_status === 'rejected' ? 'rechazada tras 3 intentos' : g.sync_status === 'duplicated' ? 'duplicada en CSHP' : 'creada en CSHP pero revisar en Supabase'}`).join(' · ') })
  const c = CARGA.garantias
  if (c?.n && c.masVieja && Date.now() - new Date(c.masVieja).getTime() > GARANTIA_ESPERA_MIN * 60000)
    out.push({ clave: 'garantias:esperando', robot: 'garantias', severidad: 'media',
      titulo: `${c.n} NDC esperando: hay que correr el robot de Garantías`,
      detalle: `La más vieja desde las ${horaGT(c.masVieja)}. Se corre a mano en su PC (correr.cmd).` })
  return out
}

const REVISIONES = { cshp: revisarCshp, carga: revisarCarga, garantias: revisarGarantias, truper: revisarTruper, robots: revisarRobots, citas: revisarCitas, correos: revisarCorreos, digitadores: revisarDigitadores, sku: revisarSku }

/* =============== Hallazgos: abrir / actualizar / cerrar =============== */
async function avisar(h, abierto) {
  if (!PROD || !ALERTAR_A.length || h.severidad !== 'alta') return false
  if (cshpCaido && /^(error|caido):/.test(h.clave)) return false   // ya se avisó 'CSHP no responde'
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#111827">
    <div style="background:#b91c1c;color:#fff;padding:10px 16px;font-weight:600">JEFE DEL DUNGEON · ALERTA</div>
    <div style="padding:16px"><h3 style="margin:0 0 10px">${esc(h.titulo)}</h3>
    <p style="margin:0 0 10px">${esc(h.detalle || '')}</p>
    ${h.causa ? `<p style="margin:0 0 6px"><b>Causa probable:</b> ${esc(h.causa)}</p>` : ''}
    ${h.accion ? `<p style="margin:0 0 6px"><b>Qué hacer:</b> ${esc(h.accion)}</p>` : ''}
    ${h.evidencia ? `<p style="margin:0 0 6px"><b>Evidencia:</b><br>${esc(h.evidencia).replace(/\n/g, '<br>')}</p>` : ''}
    ${h.aprendido ? `<p style="margin:0 0 10px;color:#92400e"><b>Lo que el Jefe ya sabe:</b><br>${esc(h.aprendido).replace(/\n/g, '<br>')}</p>` : ''}
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

  // ── Investigar: causa, evidencia y qué hacer (solo hallazgos nuevos, sin causa o que cambiaron) ──
  const abiertos = await q(KK, 'jefe_hallazgos?select=id,clave,abierto_en,avisado_en,detalle,causa,patrones&cerrado_en=is.null')
    .catch(() => q(KK, 'jefe_hallazgos?select=id,clave,abierto_en,avisado_en,detalle&cerrado_en=is.null'))
  const memoria = new Map((await q(KK, 'jefe_aprendizaje?select=*').catch((e) => { log(`(sin memoria: ${corto(e, 120)})`); return [] })).map((m) => [m.patron, m]))
  const ctx = { q, KK, CC, NOMBRES, ROBOT_DIG, cshpCaido, memoria, corto, horaGT, haceMin, USUARIOS_ROBOT: [E.CSHP_PROD_USUARIO, E.CSHP_USUARIO, E.CSHP_ROBOT_USUARIOS].join(',').split(',').map((x) => x.trim()).filter(Boolean) }
  const aprender = new Map()   // patron → datos nuevos (se cuentan una vez por hallazgo)
  for (const h of encontrados) {
    const ya = abiertos.find((a) => a.clave === h.clave)
    if (ya && ya.causa && ya.detalle === (h.detalle || null)) continue
    const inv = await investigar(h, ctx)
    if (!inv) continue
    h.causa = inv.causa; h.accion = inv.accion; h.evidencia = (inv.evidencia || []).filter(Boolean).join('\n')
    h.patrones = (inv.patrones || []).map((p) => p.patron)
    h.aprendido = recordar(inv.patrones || [], memoria).join('\n')
    h.investigado = true
    for (const p of inv.patrones || []) if (!(ya?.patrones || []).includes(p.patron)) aprender.set(p.patron, p)
    log(`   CAUSA ${h.clave}: ${h.causa || '?'}${h.accion ? ` → ${h.accion}` : ''}`)
    if (h.aprendido) log(`   SABE  ${h.aprendido.replace(/\n/g, ' | ')}`)
  }
  if (!PROD) return
  for (const o of ordenes) {
    try {
      await q(CC, 'jefe_ordenes', { method: 'POST', prefer: 'return=minimal', body: o })
      mon.ok(o.num_llamada, `Orden: cambiar SKU ${o.sku_cshp} → ${o.sku_nuevo} · ${o.motivo}`)
    } catch (e) { if (!/duplicate|23505/.test(String(e))) log(`No se pudo crear la orden ${o.num_llamada}: ${corto(e)}`) }
  }

  const ahora = new Date().toISOString()
  // ── Memoria: sumar lo que pasó de nuevo ──
  const horaAhora = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Guatemala', hour: '2-digit', hour12: false }).format(new Date()).padStart(2, '0')
  for (const [patron, p] of aprender) {
    const m = memoria.get(patron) || { patron, veces: 0, primera: ahora, horas: {}, resueltos: 0, minutos_resolver: 0 }
    // el mismo problema dentro de 6 h (p. ej. el hallazgo se cerró y se volvió a abrir) es el MISMO incidente: no suma
    const nuevo = !m.ultima || Date.now() - new Date(m.ultima).getTime() > 6 * 3600000
    const fila = { ...m, robot: p.robot || m.robot || null, causa: p.causa || m.causa, accion: p.accion || m.accion, ejemplo: p.ejemplo || m.ejemplo || null,
      veces: (m.veces || 0) + (nuevo ? 1 : 0), ultima: ahora,
      horas: nuevo ? { ...(m.horas || {}), [horaAhora]: ((m.horas || {})[horaAhora] || 0) + 1 } : (m.horas || {}) }
    memoria.set(patron, fila)
    await q(KK, 'jefe_aprendizaje?on_conflict=patron', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: fila })
      .then(() => log(`APRENDIÓ ${patron} (${fila.veces} vez/veces)`)).catch((e) => log(`No se pudo guardar aprendizaje: ${corto(e, 150)}`))
  }
  for (const h of encontrados) {
    const ya = abiertos.find((a) => a.clave === h.clave)
    const datos = { robot: h.robot || null, pc: h.pc || null, centro: h.centro || null, severidad: h.severidad, titulo: h.titulo, detalle: h.detalle || null, ultimo_visto: ahora,
      ...(h.investigado ? { causa: h.causa || null, accion: h.accion || null, evidencia: h.evidencia || null, aprendido: h.aprendido || null,
        patrones: [...new Set([...(ya?.patrones || []), ...(h.patrones || [])])], investigado_en: ahora } : {}) }
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
  const REV = { garantias: 'garantias', caido: 'robots', error: 'robots', robots: 'robots', citas: 'citas', correos: 'correos', digitadores: 'digitadores', sku: 'sku', llm: 'cshp', cshp: 'cshp' }
  const prefijo = (c) => c.startsWith('jefe:revision:') ? c.split(':')[2] : REV[c.split(':')[0]] || c.split(':')[0]
  for (const a of abiertos) {
    if (encontrados.some((h) => h.clave === a.clave)) continue
    const rev = prefijo(a.clave)
    if (!a.clave.startsWith('jefe:revision:') && !revisadas.includes(rev)) continue
    await q(KK, `jefe_hallazgos?id=eq.${a.id}`, { method: 'PATCH', body: { cerrado_en: ahora }, prefer: 'return=minimal' })
    // memoria: cuánto tardó en resolverse
    const mins = Math.max(1, Math.round((Date.now() - new Date(a.abierto_en).getTime()) / 60000))
    for (const patron of a.patrones || []) {
      const m = memoria.get(patron); if (!m) continue
      await q(KK, `jefe_aprendizaje?patron=eq.${encodeURIComponent(patron)}`, { method: 'PATCH', prefer: 'return=minimal',
        body: { resueltos: (m.resueltos || 0) + 1, minutos_resolver: Number(m.minutos_resolver || 0) + mins } }).catch(() => {})
    }
    mon.ok(null, `Resuelto: ${a.clave}`)
    log(`CERRADO ${a.clave}`)
  }
  const altos = encontrados.filter((h) => h.severidad === 'alta').length
  mon.fin(encontrados.length ? `${encontrados.length} hallazgo(s) abiertos${altos ? ` · ${altos} alto(s)` : ''}` : 'Todo en orden')
}

// Seguro: si algo se traba (CSHP, Chromium), la corrida termina sola y la tarea programada puede volver a correr
setTimeout(() => { log('ERROR la revisión pasó de 2.5 min: se cerró a la fuerza'); process.exit(3) }, 150_000).unref()

main()
  .catch((e) => { log(`ERROR ${corto(e)}`); mon.error(e); process.exitCode = 1 })
  .finally(async () => {
    await Promise.race([cerrarCSHP(sesion), new Promise((r) => setTimeout(r, 15_000))])   // cerrar Chromium a veces se traba
    await mon.flush()
    process.exit(process.exitCode ?? 0)
  })

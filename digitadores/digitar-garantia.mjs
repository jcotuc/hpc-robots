/**
 * Robot de digitadores → CSHP  (solo estado "Garantía" de la Bandeja de ConsumosCS)
 *
 * Por cada llamada de Garantía libre en la Bandeja (más antigua primero):
 *   1. La reserva en Supabase como ROBOT_NOMBRE (nadie más la puede tomar)
 *   2. Arma Resolución (igual que "Copiar" de la Bandeja) y técnico Reparacion+Nombre del catálogo
 *      → si el técnico no está en el catálogo (o es ambiguo): NO toca CSHP y la deja PENDIENTE
 *   3. CSHP: abre la llamada → Modificar → Resolución + Tipología → Aceptar
 *   4. Cambiar Status → 108 Facturación con el técnico en Observaciones
 *   5. Facturar → Aceptar el aviso
 *   6. Solo LLS: Cambiar Status → 106 Logística envío   (LLM se queda como la deja Facturar)
 *   7. Bandeja: digitada
 * Si algo falla, la llamada queda PENDIENTE en la Bandeja con el motivo y en registro.json con los
 * pasos que sí se hicieron. Nunca se vuelve a procesar sola.
 *
 * QA (CSHP de pruebas): la Bandeja es la de PRODUCCIÓN, así que en QA el robot SOLO LEE Supabase
 * (no reserva, no marca digitada ni pendiente). Para probar contra una llamada que exista en QA:
 *   SOLO_LLAMADAS=LLS21-556660   (de la Bandeja)   y   QA_LLAMADA_CSHP=LLM21-109681 (de CSHP QA)
 *
 * Uso:  npm.cmd run listar        lista lo que procesaría (no toca nada)
 *       npm.cmd run qa            QA, navegador visible y lento
 *       npm.cmd run prod          producción
 *       correr.cmd                tarea programada (ambiente según AMBIENTE del .env)
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { crearMonitor } from '../shared/monitor.mjs'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs'

// ─── Configuración ───────────────────────────────────────────────────────────
const arg = (a) => process.argv.includes(a)
const PROD = arg('--prod') || (!arg('--qa') && /^prod/i.test(process.env.AMBIENTE || ''))
const BASE = ((PROD ? process.env.CSHP_PROD_URL : process.env.CSHP_QA_URL)
  || (PROD ? 'https://taller.hpc.com.gt/CSHP' : 'https://tallerqa.hpc.com.gt/CSHP')).replace(/\/(Login\.aspx)?$/i, '')
const ES_PROD = !/tallerqa/i.test(BASE)
const USUARIO = (PROD && process.env.CSHP_PROD_USUARIO) || process.env.CSHP_USUARIO
const PASSWORD = (PROD && process.env.CSHP_PROD_PASSWORD) || process.env.CSHP_PASSWORD
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ROBOT = (process.env.ROBOT_NOMBRE || 'robot-digitadores').trim().toLowerCase()
const ESTADO_BANDEJA = (process.env.ESTADO_BANDEJA || 'Garantía').trim()
const ST_FACTURACION = (process.env.CSHP_STATUS_FACTURACION || '108').trim()
const ST_LOGISTICA = (process.env.CSHP_STATUS_LOGISTICA || '106').trim()
const TIPOLOGIA_CORRECTIVO = (process.env.CSHP_TIPOLOGIA_CORRECTIVO || '101').trim()
const TIPOLOGIA_PREVENTIVO = (process.env.CSHP_TIPOLOGIA_PREVENTIVO || '123').trim()
const MAX = Number(process.env.MAX_LLAMADAS ?? 0) || Infinity
const SOLO = String(process.env.SOLO_LLAMADAS || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)
const QA_LLAMADA_CSHP = String(process.env.QA_LLAMADA_CSHP || '').trim().toUpperCase()
const SOLO_LISTAR = arg('--solo-listar')
// --prueba: sin Supabase. Lee llamada, técnico y resolución de prueba.json y solo corre en QA
const PRUEBA = arg('--prueba')
const VISIBLE = arg('--visible') || arg('--lento')
const LENTO = arg('--lento')
// En QA nunca se escribe en la Bandeja (es la de producción)
const ESCRIBE_BANDEJA = ES_PROD && !SOLO_LISTAR
const RESERVA_MS = 30 * 60 * 1000
const mon = crearMonitor('digitadores', { intervaloSeg: 180, activo: ESCRIBE_BANDEJA && !PRUEBA })
const REGISTRO = 'registro.json'
const PATRON = /^LL[SM]\d+-\d+$/i

if (PRUEBA && ES_PROD) { console.error('❌ --prueba solo se permite en QA'); process.exit(1) }
// La Bandeja es de PRODUCCIÓN: en QA solo se permite --prueba, --solo-listar o una llamada con QA_LLAMADA_CSHP
if (!ES_PROD && !PRUEBA && !SOLO_LISTAR && !QA_LLAMADA_CSHP) {
  console.error('❌ AMBIENTE=qa: el robot no procesa la Bandeja de producción contra CSHP QA. Pon AMBIENTE=prod en .env (o usa npm.cmd run prueba)')
  process.exit(1)
}
for (const [k, v] of Object.entries({ CSHP_USUARIO: USUARIO, CSHP_PASSWORD: PASSWORD, ...(PRUEBA ? {} : { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SUPABASE_KEY }) })) {
  if (!v) { console.error(`❌ Falta ${k} en .env  (notepad .env)`); process.exit(1) }
}
const malas = [...SOLO, ...(QA_LLAMADA_CSHP ? [QA_LLAMADA_CSHP] : [])].filter((n) => !PATRON.test(n))
if (malas.length) { console.error(`❌ No son números de llamada: ${malas.join(', ')}`); process.exit(1) }
if (QA_LLAMADA_CSHP && (ES_PROD || SOLO.length !== 1)) {
  console.error('❌ QA_LLAMADA_CSHP solo se usa en QA y con UNA llamada en SOLO_LLAMADAS'); process.exit(1)
}

const sb = PRUEBA ? null : createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

// ─── Registro y logs ─────────────────────────────────────────────────────────
const ahora = () => new Date().toISOString()
const horaGT = () => new Date().toLocaleTimeString('es-GT', { timeZone: 'America/Guatemala', hour12: false })
const fechaGT = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' })
let registro = {}
try { registro = JSON.parse(readFileSync(REGISTRO, 'utf8')) } catch { /* primera vez */ }
const guardarRegistro = () => writeFileSync(REGISTRO, JSON.stringify(registro, null, 2))
const clave = (numero) => `${ES_PROD ? 'prod' : 'qa'}:${numero}`
function anotar(numero, paso, extra = {}) {
  const r = (registro[clave(numero)] ||= { inicio: ahora(), pasos: [] })
  r.pasos.push({ paso, hora: ahora(), ...extra })
  if (extra.estado) r.estado = extra.estado
  guardarRegistro()
}
const pasosHechos = (numero) => (registro[clave(numero)]?.pasos || []).map((p) => p.paso)
function log(linea) {
  console.log(linea)
  try { mkdirSync('logs', { recursive: true }); appendFileSync(`logs/detalle-${fechaGT()}.log`, `${horaGT()}  ${linea}\r\n`) } catch { /* nunca detiene */ }
}
function resumen(linea) {
  mon.linea(linea)
  try { mkdirSync('logs', { recursive: true }); appendFileSync(`logs/resumen-${fechaGT()}.log`, `${horaGT()}  ${linea}\r\n`) } catch { /* nunca detiene */ }
}

// ─── Diagnóstico (copiado de ConsumosCS: llamadas-diagnostico.ts, llamadas-machotes.ts, llamadas-diagnostico-revision.ts) ──
// El texto que pega el robot es EXACTAMENTE el del botón "Copiar" de la Bandeja:
//   resultado revisado y guardado por un digitador (si existe)  >  machote del caso + recomendación del SKU
const normalizar = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
const PREVENTIVO_RE = /sin\s*fallas?|sin\s*causas?|mantenimiento/
function tipoMantenimiento(fallas, causas) {
  const items = [...fallas, ...causas].map((t) => t.trim()).filter(Boolean)
  if (items.length === 0) return 'Preventivo'
  return items.every((t) => !normalizar(t).includes('correctivo') &&
    (PREVENTIVO_RE.test(normalizar(t)) || normalizar(t) === 'n/a')) ? 'Preventivo' : 'Correctivo'
}
const limpiarRecomendacion = (t) => String(t ?? '').trim().replace(/^recomendaciones:\s*/i, '').trim()

function diagnosticoPorCaso(input) {
  const pares = input.pares.filter((p) => p.falla.trim() || p.causa.trim())
  const estado = normalizar(input.estado ?? '')
  const tipo = estado.includes('mantenimiento correctivo') ? 'Correctivo'
    : estado.includes('mantenimiento preventivo') || estado === 'sin fallas' ? 'Preventivo'
    : tipoMantenimiento(pares.map((p) => p.falla), pares.map((p) => p.causa))
  const sinFallas = estado === 'sin fallas' || (pares.length > 0 && pares.every((p) =>
    /^sin\s+fallas?\b/.test(normalizar(p.falla)) && (!p.causa.trim() || /^(sin\s+causas?|n\/a)$/.test(normalizar(p.causa)))))
  const caso = estado === 'cambio por garantia' ? 'Cambio por garantía'
    : estado === 'nota de credito' ? 'Nota de crédito'
    : estado === 'pendiente por repuesto' ? 'Pendiente por repuesto'
    : estado === 'canje' ? 'Canje'
    : estado === 'presupuesto' ? 'Presupuesto'
    : sinFallas ? 'Sin fallas'
    : `Mantenimiento ${tipo.toLowerCase()}`
  const lineas = pares.map((p) => (p.causa.trim() ? `${p.falla.trim()} - ${p.causa.trim()}` : p.falla.trim()))
  const mantenimiento = caso === 'Sin fallas' || caso.startsWith('Mantenimiento')
  const observacion = input.observaciones?.trim() || (mantenimiento && (pares.length > 0 || estado.includes('mantenimiento') || sinFallas)
    ? 'Se realizó el mantenimiento.' : '')
  const secciones = []
  if (caso === 'Cambio por garantía') secciones.push({ titulo: 'Procedimiento', contenido: 'En este caso se procede a dar cambio por garantía.' })
  if (caso === 'Canje') {
    const producto = [input.productoViejoCodigo, input.productoViejoDesc].filter(Boolean).join(' — ')
    secciones.push({ titulo: 'Modelo que ingresa', contenido: producto || 'No registrado' })
  }
  secciones.push({ titulo: 'Fallas y posibles causas', contenido: sinFallas && mantenimiento ? 'Sin fallas, se hace mantenimiento general. - N/A' : lineas.join('\n') })
  if (mantenimiento) secciones.push({ titulo: 'Tipo de mantenimiento', contenido: tipo })
  if (caso === 'Presupuesto' || caso === 'Canje') secciones.push({ titulo: 'Por los daños encontrados aplica', contenido: caso === 'Presupuesto' ? 'Presupuesto por reparación' : 'Canje de cambio' })
  if (caso === 'Canje') {
    const producto = [input.productoNuevoCodigo, input.productoNuevoDesc].filter(Boolean).join(' — ')
    secciones.push({ titulo: 'Producto ofrecido', contenido: producto ? `Se ofrece SKU ${producto}` : 'No registrado' })
  }
  secciones.push({ titulo: 'Observación', contenido: observacion })
  const recomendacion = limpiarRecomendacion(input.recomendacion) || 'Sin recomendación registrada para este SKU.'
  return { caso, tipo, secciones, recomendacion }
}

const CLAVE_MACHOTE = { 'Sin fallas': 'sin_fallas', 'Mantenimiento correctivo': 'correctivo', 'Mantenimiento preventivo': 'preventivo', Presupuesto: 'presupuesto', Canje: 'canje', 'Cambio por garantía': 'cambio_garantia', 'Nota de crédito': 'nota_credito', 'Pendiente por repuesto': 'pendiente_repuesto' }
function diagnosticoConMachote(input, machotes = []) {
  const base = diagnosticoPorCaso(input)
  const machote = machotes.find((m) => m.clave === (CLAVE_MACHOTE[base.caso] ?? 'preventivo'))
  const contenido = (titulo) => base.secciones.find((s) => s.titulo === titulo)?.contenido ?? ''
  const valores = {
    fallas_causas: contenido('Fallas y posibles causas'), tipo_mantenimiento: base.tipo,
    observacion: contenido('Observación'), producto_viejo: contenido('Modelo que ingresa'), producto_nuevo: contenido('Producto ofrecido'),
  }
  const sustituir = (t) => String(t).replace(/\{\{([^{}]+)\}\}/g, (_, c) => valores[c] ?? '')
  const secciones = machote ? machote.secciones.map((s) => ({ titulo: sustituir(s.titulo), contenido: sustituir(s.contenido) })) : base.secciones
  const encabezado = machote?.encabezado ?? 'DIAGNÓSTICO'
  const texto = [encabezado, ...secciones.map((s) => `${s.titulo.toLocaleUpperCase('es')}:\n${s.contenido}`), `RECOMENDACIONES:\n${base.recomendacion}`].join('\n\n')
  return { ...base, texto }
}
function separarDiagnostico(texto) {
  const partes = texto.split(/(?:^|\n)RECOMENDACIONES:\s*\n?/i)
  return { diagnostico: partes[0].trim(), recomendacion: partes.slice(1).join('\n').trim() }
}
const textoRevision = (d, r) => `${d.trim()}\n\nRECOMENDACIONES:\n${r.trim().replace(/^(?:RECOMENDACIONES:\s*)+/i, '')}`

const sinPrefijo = (n) => String(n).trim().replace(/^(?:reparaci[oó]n|diagn[oó]stico)\s*\+\s*/i, '')
function tecnicoDelCatalogo(nombre, catalogo) {
  const norm = (v) => normalizar(sinPrefijo(v)).replace(/\s+/g, ' ')
  const buscado = norm(nombre ?? '')
  if (!buscado) return undefined
  const exactos = catalogo.filter((v) => norm(v) === buscado)
  if (exactos.length === 1) return exactos[0]
  const literal = exactos.find((v) => sinPrefijo(v) === sinPrefijo(nombre ?? ''))
  if (literal) return literal
  const palabras = buscado.split(' ')
  const cand = catalogo.filter((v) => {
    const partes = norm(v).split(' ')
    if (partes.length < 2) return false
    let pos = 0
    return partes.every((p) => { const i = palabras.indexOf(p, pos); if (i < 0) return false; pos = i + 1; return true })
  })
  return cand.length === 1 ? cand[0] : undefined
}
const tecnicoReparacion = (n) => (/^reparacion\+/i.test(normalizar(n)) ? n.trim() : `Reparacion+${sinPrefijo(n)}`)

// ─── Bandeja (Supabase) ──────────────────────────────────────────────────────
async function robotActivo() {
  const { data, error } = await sb.from('etiquetera_config').select('valor').eq('clave', 'robot_garantia_activo').maybeSingle()
  if (error) throw new Error(`Supabase (etiquetera_config): ${error.message}`)
  return data?.valor === true
}

async function estadoId() {
  const { data, error } = await sb.from('llamadas_estados').select('id, nombre')
  if (error) throw new Error(`Supabase (llamadas_estados): ${error.message}`)
  const e = data.find((x) => normalizar(x.nombre) === normalizar(ESTADO_BANDEJA))
  if (!e) throw new Error(`No existe el estado "${ESTADO_BANDEJA}" en la Bandeja. Hay: ${data.map((x) => x.nombre).join(', ')}`)
  return e.id
}

async function candidatas(idEstado) {
  let q = sb.from('llamadas_actualizaciones')
    .select('id, num_llamada, created_at, centro_id, tecnico_nombre, producto_sku, fallas, observaciones, producto_viejo_codigo, producto_viejo_desc, producto_nuevo_codigo, producto_nuevo_desc, tecnico_id, tomado_por, tomado_en, pendiente_en, pendiente_motivo, llamadas_centros(nombre), llamadas_estados(nombre)')
    .eq('estado_id', idEstado).is('digitado_en', null).is('garantia_id', null)
    // libres, o pendientes que dejó el propio robot (se reintentan si se puede); las de digitadores no se tocan
    .or(`pendiente_en.is.null,pendiente_por.eq.${ROBOT}`)
    .order('created_at', { ascending: true }).order('id', { ascending: true }).limit(200)
  if (SOLO.length) q = q.in('num_llamada', SOLO)
  const { data, error } = await q
  if (error) throw new Error(`Supabase (llamadas_actualizaciones): ${error.message}`)
  const limite = Date.now() - RESERVA_MS
  // Libres, o reservadas por el robot (corrida anterior que se cortó antes de terminar)
  return data.filter((a) => !a.tomado_por || !a.tomado_en || new Date(a.tomado_en).getTime() <= limite || a.tomado_por.toLowerCase() === ROBOT)
    .filter((a) => !a.pendiente_en || puedeReintentar(a))
}

// ─── Reintentos ──────────────────────────────────────────────────────────────
const PASOS_CSHP = ['sku', 'resolucion', 'facturacion', 'facturar', 'logistica']
const MAX_INTENTOS = 3
const tocoCSHP = (numero) => pasosHechos(numero).some((p) => PASOS_CSHP.includes(p))
const errores = (numero) => pasosHechos(numero).filter((p) => p === 'error').length
/** Una pendiente del robot se vuelve a tomar solo si NO cambió nada en CSHP y no agotó sus intentos */
function puedeReintentar(a) {
  const n = (QA_LLAMADA_CSHP || a.num_llamada).toUpperCase()
  if (tocoCSHP(n)) return false
  if (/^T[eé]cnico no identificado/i.test(a.pendiente_motivo || '')) return true // se revisa el catálogo en cada vuelta
  if (/^El SKU no coincide/i.test(a.pendiente_motivo || '')) return true // se re-evalúa antes de abrir CSHP (ver main)
  // Pendiente a propósito (p. ej. SKU que no coincide): se queda para el digitador
  if (pasosHechos(n).at(-1) === 'pendiente') return false
  return errores(n) < MAX_INTENTOS
}

/** Reserva atómica: solo si sigue libre (o ya es del robot). Devuelve false si un digitador la tomó antes */
async function reservar(a) {
  if (!ESCRIBE_BANDEJA) return true
  const limite = new Date(Date.now() - RESERVA_MS).toISOString()
  const { data, error } = await sb.from('llamadas_actualizaciones')
    .update({ tomado_por: ROBOT, tomado_en: ahora(), pendiente_en: null, pendiente_por: null, pendiente_motivo: null })
    .eq('id', a.id).is('digitado_en', null)
    .or(`pendiente_en.is.null,pendiente_por.eq.${ROBOT}`)
    .or(`tomado_por.is.null,tomado_en.is.null,tomado_en.lte.${limite},tomado_por.eq.${ROBOT}`)
    .select('id')
  if (error) throw new Error(`Supabase (reservar): ${error.message}`)
  return data.length === 1
}

async function marcarDigitada(a) {
  if (!ESCRIBE_BANDEJA) return
  const { data, error } = await sb.from('llamadas_actualizaciones')
    .update({ digitado_por: ROBOT, digitado_en: ahora() })
    .eq('id', a.id).eq('tomado_por', ROBOT).is('digitado_en', null).select('id')
  if (error || data.length !== 1) throw new Error(`No se pudo marcar digitada en la Bandeja: ${error?.message || 'la reserva ya no es del robot'}`)
}

async function dejarPendiente(a, motivo = '') {
  if (!ESCRIBE_BANDEJA) return
  const cambios = { pendiente_en: ahora(), pendiente_por: ROBOT, tomado_por: null, tomado_en: null, pendiente_motivo: motivo.slice(0, 500) || null }
  let { error } = await sb.from('llamadas_actualizaciones').update(cambios).eq('id', a.id).is('digitado_en', null)
  if (error && /pendiente_motivo/i.test(error.message)) {
    // La columna pendiente_motivo aún no existe en la Bandeja: se deja pendiente sin motivo
    delete cambios.pendiente_motivo
    ;({ error } = await sb.from('llamadas_actualizaciones').update(cambios).eq('id', a.id).is('digitado_en', null))
  }
  if (error) log(`   ⚠️ No se pudo dejar pendiente en la Bandeja: ${error.message}`)
}

/** Familia y categoría de un SKU según el catálogo de la Bandeja (null si el SKU no está relacionado) */
async function categoriaDeSku(sku) {
  const { data, error } = await sb.from('llamadas_producto_categorias')
    .select('categoria_id, llamadas_categorias(nombre, familia)').eq('sku', String(sku).trim()).maybeSingle()
  if (error || !data) return null
  return { id: data.categoria_id, nombre: data.llamadas_categorias?.nombre || '', familia: data.llamadas_categorias?.familia || '' }
}

const esCodigo = (v) => /^\d+$/.test(String(v ?? '').trim())
/** Formulario con texto en vez de SKU (p. ej. "Roto martillo industrial 810 w.") que describe la categoría del SKU de CSHP */
function textoCoincideCategoria(texto, cat) {
  if (!cat?.nombre) return false
  const plano = (t) => normalizar(t).replace(/[^a-z0-9]/g, '')
  const t = plano(texto)
  return normalizar(cat.nombre).split(/\s+/).filter((w) => w.length > 3 && !/^\d+$/.test(w))
    .some((w) => t.includes(plano(w).replace(/s$/, '')))
}
/** ¿Se puede resolver solo una diferencia de SKU? 'mismo' (se queda el de CSHP), 'cambiar' (se pone el del formulario) o null */
async function decisionSku(skuForm, skuCshp) {
  const catCSHP = await categoriaDeSku(skuCshp)
  if (!esCodigo(skuForm)) return { accion: textoCoincideCategoria(skuForm, catCSHP) ? 'mismo' : null, catForm: null, catCSHP }
  const catForm = await categoriaDeSku(skuForm)
  const mismo = catForm && catCSHP && (catForm.id === catCSHP.id || normalizar(catForm.nombre) === normalizar(catCSHP.nombre))
  return { accion: mismo ? 'cambiar' : null, catForm, catCSHP }
}

/** Quién subió la llamada a la Bandeja: nombre escrito + cuenta (si tenía sesión) */
async function quienSubio(a) {
  let correo = ''
  if (a.tecnico_id && sb) {
    const { data } = await sb.auth.admin.getUserById(a.tecnico_id).catch(() => ({ data: null }))
    correo = data?.user?.email || ''
  }
  return [a.tecnico_nombre, correo && `(${correo})`].filter(Boolean).join(' ') || 'sin dato'
}

/** Devuelve la llamada a la cola (sin pendiente) para reintentarla en la siguiente vuelta */
async function soltar(a) {
  if (!ESCRIBE_BANDEJA) return
  const { error } = await sb.from('llamadas_actualizaciones').update({ tomado_por: null, tomado_en: null })
    .eq('id', a.id).eq('tomado_por', ROBOT).is('digitado_en', null)
  if (error) log(`   ⚠️ No se pudo soltar en la Bandeja: ${error.message}`)
}

/** Última corrida del robot, para verla en Administración (tabla opcional robot_estado) */
async function latido(resultado, error = null) {
  if (!ESCRIBE_BANDEJA) return
  const { error: e } = await sb.from('robot_estado')
    .upsert({ robot: ROBOT, ultima_corrida: ahora(), ultimo_resultado: resultado.slice(0, 500), ultimo_error: error ? String(error).slice(0, 500) : null })
  if (e && !/robot_estado/i.test(e.message)) log(`   ⚠️ No se pudo registrar la corrida: ${e.message}`)
}

let machotesCache = null
async function machotes() {
  if (machotesCache) return machotesCache
  const { data, error } = await sb.from('llamadas_diagnostico_machotes').select('clave, encabezado, secciones')
  if (error) throw new Error(`Supabase (machotes): ${error.message}`)
  return (machotesCache = data || [])
}

async function datosLlamada(a) {
  const [tec, rec, rev, mach] = await Promise.all([
    sb.from('llamadas_tecnicos').select('nombre').eq('centro_id', a.centro_id).eq('tipo', 'reparacion'),
    a.producto_sku ? sb.from('llamadas_producto_recomendaciones').select('texto').eq('sku', a.producto_sku).maybeSingle() : { data: null },
    sb.from('llamadas_diagnostico_resultados').select('diagnostico_texto, recomendacion_texto').eq('actualizacion_id', a.id).maybeSingle(),
    machotes(),
  ])
  for (const [n, r] of [['llamadas_tecnicos', tec], ['recomendaciones', rec], ['diagnostico_resultados', rev]]) {
    if (r.error) throw new Error(`Supabase (${n}): ${r.error.message}`)
  }
  let oficial = tecnicoDelCatalogo(a.tecnico_nombre, (tec.data || []).map((t) => t.nombre))
  let otroCentro = false
  if (!oficial) {
    // Técnicos que trabajan llamadas de otro centro (p. ej. de Zona 6 en Zona 4): se busca en todo el catálogo de reparación
    const todos = await sb.from('llamadas_tecnicos').select('nombre').eq('tipo', 'reparacion')
    if (todos.error) throw new Error(`Supabase (llamadas_tecnicos): ${todos.error.message}`)
    oficial = tecnicoDelCatalogo(a.tecnico_nombre, [...new Set((todos.data || []).map((t) => t.nombre))])
    otroCentro = !!oficial
  }
  const pares = (Array.isArray(a.fallas) ? a.fallas : []).map((p) => ({ falla: String(p?.falla ?? ''), causa: String(p?.causa ?? '') }))
  const diag = diagnosticoConMachote({
    pares, estado: a.llamadas_estados?.nombre, observaciones: a.observaciones, recomendacion: rec.data?.texto,
    productoViejoCodigo: a.producto_viejo_codigo, productoViejoDesc: a.producto_viejo_desc,
    productoNuevoCodigo: a.producto_nuevo_codigo, productoNuevoDesc: a.producto_nuevo_desc,
  }, mach)
  const partes = rev.data
    ? { diagnostico: rev.data.diagnostico_texto, recomendacion: rev.data.recomendacion_texto }
    : separarDiagnostico(diag.texto)
  return {
    catalogo: (tec.data || []).length,
    otroCentro,
    tecnico: oficial ? tecnicoReparacion(oficial) : null,
    resolucion: textoRevision(partes.diagnostico, partes.recomendacion),
    revisado: !!rev.data,
    tipo: diag.tipo,
    tipologia: diag.tipo === 'Preventivo' ? TIPOLOGIA_PREVENTIVO : TIPOLOGIA_CORRECTIVO,
  }
}

// ─── CSHP ────────────────────────────────────────────────────────────────────
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
  if (err && /error|no se|inv[aá]lid|no permit|requer|obligat|debe/i.test(err)) throw new Error(`CSHP en ${paso}: ${err}`)
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
    await page.getByRole('button', { name: 'Submit', exact: true }).click().catch(() => page.locator('#FrmAcceso1_TxtPassword').press('Enter'))
    await page.waitForURL((u) => !/Login/i.test(u.pathname), { timeout: 10_000 }).catch(() => {})
    await esperarCSHP(page)
    if (!/Login|BloqSeguridad/i.test(page.url())) { log('🔐 Sesión iniciada en CSHP'); return }
    log(`   ⚠️ Inicio de sesión no aceptado (intento ${intento}/3)`)
    await page.waitForTimeout(2_000)
  }
  throw new Error(`No se pudo iniciar sesión en CSHP con ${USUARIO}. Captura: ${await captura(page, 'login')}`)
}

/** Lista de llamadas → filtra por número → abre exactamente esa llamada */
async function abrirLlamada(page, numero) {
  await page.goto(`${BASE}/LLamadasServ.aspx`, { waitUntil: 'domcontentloaded' })
  if (/Login|BloqSeguridad/i.test(page.url())) { await login(page); await page.goto(`${BASE}/LLamadasServ.aspx`, { waitUntil: 'domcontentloaded' }) }
  await esperarCSHP(page)
  const link = page.getByRole('link', { name: numero, exact: true })
  // CSHP a veces tarda en devolver la lista: hasta 2 búsquedas, esperando 20 s cada una
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
  // Abierta = aparece el botón Cambiar Status, o el status es Cerrado (las cerradas no tienen ese botón)
  const limite = Date.now() + 30_000
  const esEsta = () => page.evaluate((n) => [...document.querySelectorAll('body *')].some((e) =>
    e.childElementCount === 0 && e.tagName !== 'A' && e.offsetParent !== null && e.textContent.trim().toUpperCase() === n), numero).catch(() => false)
  while (true) {
    const lista = await page.locator('#FrmLLamadasServ_CmdCambiarStatus').isVisible().catch(() => false)
      || (await filasLog(page).count().catch(() => 0)) > 0 // cerradas o en Logística no siempre traen el botón
    if (lista && await esEsta()) { await esperarCSHP(page); break }
    if (Date.now() > limite) throw new Error(`CSHP no terminó de abrir ${numero} (30 s)`)
    await page.waitForTimeout(500)
  }
}

async function escribirResolucion(page, d) {
  await page.getByRole('button', { name: 'Modificar' }).click()
  await esperarCSHP(page)
  if (d.skuNuevo) {
    const campo = page.locator('#FrmLLamadasServ_TxtSKU')
    await campo.waitFor({ state: 'visible', timeout: 15_000 })
    await campo.fill(d.skuNuevo)
    await campo.press('Tab').catch(() => {}) // CSHP busca el artículo al salir del cuadro
    await esperarCSHP(page)
    await page.waitForTimeout(1_000)
    await revisarError(page, `SKU ${d.skuNuevo}`)
  }
  const txt = page.locator('#FrmLLamadasServ_TxtResolucion')
  await txt.waitFor({ state: 'visible', timeout: 15_000 })
  await txt.fill(d.resolucion)
  d.tipologiaCSHP = await ponerTipologia(page, d.tipologia)
  await clic(page, '#FrmLLamadasServ_CmdAceptar')
  await esperarCSHP(page)
  await revisarError(page, 'Modificar')
  if (d.skuNuevo) {
    const quedo = await skuCSHP(page)
    if (quedo && quedo.replace(/^0+/, '') !== d.skuNuevo.replace(/^0+/, '')) throw new Error(`CSHP no guardó el SKU ${d.skuNuevo} (quedó ${quedo})`)
  }
}

/** Tipología por código o por texto (sin tildes). Si no existe, muestra las opciones de CSHP */
async function ponerTipologia(page, tipologia) {
  const combo = page.locator('#FrmLLamadasServ_CmbTipologia')
  await combo.waitFor({ state: 'visible', timeout: 15_000 })
  const ops = await combo.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: (o.textContent || '').trim() })))
  const b = normalizar(tipologia)
  const op = ops.find((o) => o.v === tipologia) || ops.find((o) => normalizar(o.t) === b)
    || ops.find((o) => o.v && normalizar(o.t).includes(b))
  if (!op) throw new Error(`No existe la tipología "${tipologia}" en CSHP. Opciones: ${ops.map((o) => `${o.v}=${o.t}`).join(' | ')}`)
  await combo.selectOption(op.v)
  await esperarCSHP(page)
  return op.t
}

/** Veces que aparece "Cambio Status → <status>" en el log de la llamada (tabla de abajo) */
const filasLog = (page) => page.locator('tr').filter({ hasNot: page.locator('tr') }).filter({ hasText: 'Cambio Status' })
async function vecesEnLog(page, statusTexto) {
  return filasLog(page).filter({ hasText: statusTexto }).count().catch(() => -1)
}

/** Status actual de la llamada (texto junto a la etiqueta "Status" del encabezado) */
async function statusActual(page) {
  // El primer renglón del log es el status actual (incluye "Cerrado")
  return ultimoStatus(page)
}

/** SKU que muestra CSHP en la llamada abierta (cuadro bajo la etiqueta "SKU") */
async function skuCSHP(page) {
  const directo = await page.locator('#FrmLLamadasServ_TxtSKU').inputValue({ timeout: 2_000 }).catch(() => '')
  if (directo.trim()) return directo.trim()
  return page.evaluate(() => {
    const etiqueta = [...document.querySelectorAll('span,label,td,div,b')].find((e) => e.childElementCount === 0 && e.textContent.trim() === 'SKU')
    if (!etiqueta) return ''
    const todos = [...document.querySelectorAll('input[type=text], input:not([type])')]
    const sig = todos.find((i) => etiqueta.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING)
    return (sig?.value || '').trim()
  }).catch(() => '')
}

// Cambiar el SKU en CSHP: falta la grabación de ese paso. Mientras sea false, las de misma categoría
// quedan pendientes con el motivo "corregir en CSHP el SKU X por Y" para que el digitador lo haga.
// Grabación 2026-11-03: Modificar → #FrmLLamadasServ_TxtSKU → (Resolución, Tipología) → Aceptar
const CAMBIAR_SKU_LISTO = true

/** Status más reciente del log de la llamada (la primera fila es la última) */
async function ultimoStatus(page) {
  const fila = filasLog(page).first()
  return (await fila.locator('td').nth(2).innerText({ timeout: 2_000 }).catch(() => '')).trim()
}

async function cambiarStatus(page, codigo, observaciones = null) {
  await page.locator('#FrmLLamadasServ_CmdCambiarStatus').waitFor({ state: 'visible', timeout: 20_000 })
    .catch(() => { throw new Error('CSHP no muestra el botón Cambiar Status en esta llamada') })
  await clic(page, '#FrmLLamadasServ_CmdCambiarStatus')
  await esperarCSHP(page)
  const combo = page.locator('#FrmLLamadasServ_CmbStatusN')
  await combo.waitFor({ state: 'visible', timeout: 15_000 })
  const ops = await combo.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: (o.textContent || '').trim() })))
  const op = ops.find((o) => o.v === codigo)
  if (!op) throw new Error(`No aparece el status ${codigo} en Nuevo Status. Opciones: ${ops.map((o) => `${o.v}=${o.t}`).join(' | ')}`)
  const antes = await vecesEnLog(page, op.t)
  await combo.selectOption(op.v)
  await esperarCSHP(page)
  if (observaciones !== null) {
    const obs = page.locator('#FrmLLamadasServ_TxtObservaciones')
    await obs.fill(observaciones)
    // Salir del cuadro ANTES de Aceptar: CSHP procesa el cambio del texto y ese postback se "come" el clic
    await obs.press('Tab').catch(() => {})
    await esperarCSHP(page)
    await page.waitForTimeout(1_000)
  }

  // Aceptar; solo se vuelve a presionar si el log confirma que el cambio NO se registró (nunca duplica)
  for (let intento = 1; intento <= 2; intento++) {
    await clic(page, '#FrmLLamadasServ_CmdAceptarCambio')
    await esperarCSHP(page)
    const cerro = await combo.waitFor({ state: 'hidden', timeout: 30_000 }).then(() => true).catch(() => false)
    await revisarError(page, `Cambiar Status ${codigo}`)
    const despues = await vecesEnLog(page, op.t)
    const registrado = antes >= 0 && despues > antes
    if (cerro || registrado) {
      if (!cerro) {
        // Se registró pero la ventana quedó abierta: se cierra con Cancelar (no repite el cambio)
        await page.locator('[id*="CancelarCambio"], [id*="CmdCancelarC"]').first().click({ timeout: 3_000 }).catch(() => {})
        await esperarCSHP(page)
      }
      if (cerro && antes >= 0 && !registrado) log(`   ⚠️ La ventana cerró pero no veo "${op.t}" nuevo en el log de la llamada`)
      return op.t
    }
    if (antes < 0) break // no se puede leer el log: no se arriesga a duplicar
    log(`   ↻ CSHP no registró el cambio a ${op.t} (intento ${intento}); ${intento < 2 ? 'se presiona Aceptar otra vez' : 'se detiene'}`)
  }
  throw new Error(`Cambio a status ${codigo}: CSHP no lo registró y la ventana sigue abierta`)
}

async function facturar(page) {
  let aviso = ''
  const alAviso = (dialog) => { aviso = dialog.message(); dialog.accept().catch(() => {}) }
  page.once('dialog', alAviso)
  await clic(page, '#FrmLLamadasServ_CmdFacturar')
  await esperarCSHP(page)
  page.off('dialog', alAviso)
  await revisarError(page, 'Facturar')
  return aviso
}

// ─── Proceso de una llamada ──────────────────────────────────────────────────
async function procesar(page, a) {
  const numero = a.num_llamada.toUpperCase()
  const destino = QA_LLAMADA_CSHP || numero
  const esLLS = /^LLS/i.test(destino)
  // Solo se bloquea si un intento anterior YA CAMBIÓ algo en CSHP (para no duplicar status ni facturar dos veces)
  const hechos = pasosHechos(destino).filter((p) => PASOS_CSHP.includes(p))
  if (!PRUEBA && hechos.length && registro[clave(destino)]?.estado !== 'completa') {
    throw new Error(`Un intento anterior ya hizo en CSHP: ${hechos.join(', ')}. Revísala a mano`)
  }

  const d = a.prueba || a.datos || await datosLlamada(a)
  if (!d.tecnico) {
    const motivo = `Técnico no identificado en el catálogo: "${a.tecnico_nombre ?? ''}"${a.tecnico_id ? ` · subió ${await quienSubio(a)}` : ''}`
    log(`   🔎 Catálogo reparación del centro ${a.centro_id}: ${d.catalogo} técnico(s)`)
    await dejarPendiente(a, motivo)
    anotar(destino, 'pendiente', { estado: 'pendiente', motivo })
    log(`   ⏸️  ${numero}: ${motivo} → pendiente para digitador`)
    resumen(`${numero}  PENDIENTE  ${motivo}`)
    return 'pendiente'
  }
  log(`   ↳ ${d.tecnico}${d.otroCentro ? ' (catálogo de otro centro)' : ''} · ${d.tipo} → tipología ${d.tipologia}${d.revisado ? ' · diagnóstico revisado por digitador' : ''}${destino !== numero ? ` · CSHP QA: ${destino}` : ''}`)

  await abrirLlamada(page, destino)
  // El SKU de la Bandeja debe coincidir con el de CSHP; si no, casi seguro el número de llamada está mal escrito
  const sku = await skuCSHP(page)
  if (!PRUEBA && a.producto_sku && sku && sku.replace(/^0+/, '') !== String(a.producto_sku).trim().replace(/^0+/, '')) {
    const st = await statusActual(page)
    const { accion, catForm, catCSHP } = await decisionSku(a.producto_sku, sku)
    const mismaCategoria = !!accion
    const abierta = !/cerrad/i.test(st) && (await vecesEnLog(page, 'T - Facturación')) === 0
    const desc = (c) => (c ? `${c.familia} · ${c.nombre}` : 'sin categoría en el catálogo')
    if (accion === 'mismo' && abierta) {
      // El formulario trae una descripción, no un SKU, y coincide con el producto de CSHP: se deja el SKU de CSHP
      anotar(destino, 'sku', { formulario: a.producto_sku, cshp: sku, accion: 'se conserva el de CSHP' })
      log(`   ↳ Formulario sin SKU ("${a.producto_sku}"), coincide con CSHP ${sku} (${desc(catCSHP)}): se conserva`)
    } else if (accion === 'cambiar' && abierta && CAMBIAR_SKU_LISTO) {
      // Mismo tipo de producto: el SKU se corrige con el del formulario en el mismo "Modificar" de la resolución
      d.skuNuevo = String(a.producto_sku).trim()
      d.skuAntes = sku
      log(`   ↳ SKU se corrige en CSHP: ${sku} → ${d.skuNuevo} (${desc(catForm)})`)
    } else {
    const razon = !mismaCategoria ? `producto distinto: formulario ${a.producto_sku} (${esCodigo(a.producto_sku) ? desc(catForm) : 'texto, no SKU'}), CSHP ${sku} (${desc(catCSHP)})`
      : !abierta ? `misma categoría (${desc(catForm)}) pero la llamada en CSHP ya está ${st || 'facturada'}`
      : `misma categoría (${desc(catForm)}): corregir en CSHP el SKU ${sku} por ${a.producto_sku}`
    const motivo = `El SKU no coincide, ${razon}. Revisar con ${await quienSubio(a)}`
    // Diagnóstico: todos los campos con "SKU" en su id y una captura, para revisar de dónde salió el valor
    const camposSku = await page.evaluate(() => [...document.querySelectorAll('input, select, span')]
      .filter((e) => /sku|articulo/i.test(e.id)).map((e) => `${e.id}=${(e.value ?? e.textContent ?? '').trim()}${e.offsetParent === null ? ' (oculto)' : ''}`)).catch(() => [])
    log(`   🔎 Campos SKU en CSHP: ${camposSku.join(' | ') || '(ninguno)'} · captura: ${await captura(page, `${numero}-sku`)}`)
    await dejarPendiente(a, motivo)
    anotar(destino, 'pendiente', { estado: 'pendiente', motivo })
    log(`   ⏸️  ${numero}: ${motivo}`)
    resumen(`${numero}  PENDIENTE  ${motivo}`)
    return 'pendiente'
    }
  }
  // Ya digitada en CSHP (alguien la facturó antes): no se toca nada, solo se marca digitada en la Bandeja
  const yaFacturada = await vecesEnLog(page, 'T - Facturación')
  const actual = await statusActual(page)
  log(`   ↳ CSHP: status ${actual || '?'}${yaFacturada > 0 ? ' · ya tiene T - Facturación en el log' : ''}`)
  if (yaFacturada > 0 || /cerrad/i.test(actual)) {
    const st = actual || await ultimoStatus(page)
    await marcarDigitada(a)
    anotar(destino, 'ya_digitada', { estado: 'completa', status: st })
    log(`   ✔️ Ya estaba digitada en CSHP (status ${st || 'cerrada'}): solo se marca digitada en la Bandeja`)
    resumen(`${numero}  YA DIGITADA  CSHP en ${st || 'cerrada'}`)
    return 'ya'
  }
  await escribirResolucion(page, d)
  if (d.skuNuevo) anotar(destino, 'sku', { antes: d.skuAntes, despues: d.skuNuevo })
  anotar(destino, 'resolucion', { tipologia: d.tipologiaCSHP })
  log(`   ↳ Resolución y tipología ${d.tipologiaCSHP} guardadas`)

  const st = await cambiarStatus(page, ST_FACTURACION, d.tecnico)
  anotar(destino, 'facturacion', { status: st, tecnico: d.tecnico })
  log(`   ↳ Status → ${st}`)

  const aviso = await facturar(page)
  anotar(destino, 'facturar', { aviso })
  log(`   ↳ Facturada${aviso ? ` (aviso: ${aviso})` : ''}`)

  if (esLLS) {
    await abrirLlamada(page, destino)
    const st2 = await cambiarStatus(page, ST_LOGISTICA)
    anotar(destino, 'logistica', { status: st2 })
    log(`   ↳ Status → ${st2}`)
  }

  await marcarDigitada(a)
  anotar(destino, 'digitada', { estado: 'completa' })
  resumen(`${numero}  DIGITADA  ${d.tecnico} · ${d.tipologia}${esLLS ? ' · logística' : ''}`)
  return 'digitada'
}

// ─── Principal ───────────────────────────────────────────────────────────────
const LOCK = '.sync.lock'
function tomarLock() {
  try { if (Date.now() - statSync(LOCK).mtimeMs > 30 * 60 * 1000) unlinkSync(LOCK) } catch { /* no existe */ }
  try { closeSync(openSync(LOCK, 'wx')); return true } catch { return false }
}

/** Modo prueba: arma la llamada con los datos de prueba.json (sin tocar Supabase) */
function llamadasDePrueba() {
  let p
  try { p = JSON.parse(readFileSync('prueba.json', 'utf8')) }
  catch (e) { throw new Error(`No se pudo leer prueba.json: ${e.message}`) }
  // "llamadas": [...] usa los mismos datos para varias llamadas; "llamada": "..." para una
  const nums = Array.isArray(p.llamadas) ? p.llamadas : [p.llamada]
  return nums.map((llamada) => llamadaDePrueba({ ...p, llamada }))
}

function llamadaDePrueba(p) {
  const llamada = String(p.llamada || '').trim().toUpperCase()
  if (!PATRON.test(llamada)) throw new Error(`prueba.json: "llamada" no es un número válido (${p.llamada})`)
  const resolucion = Array.isArray(p.resolucion) ? p.resolucion.join('\n') : String(p.resolucion || '')
  if (!resolucion.trim()) throw new Error('prueba.json: falta "resolucion"')
  const tecnico = String(p.tecnico || '').trim()
  // Tipo según la línea "TIPO DE MANTENIMIENTO:" de la resolución (o "tipo" en prueba.json)
  const tipo = /preventivo/i.test(p.tipo || resolucion.match(/TIPO DE MANTENIMIENTO:\s*(\w+)/i)?.[1] || '') ? 'Preventivo' : 'Correctivo'
  return {
    num_llamada: llamada,
    tecnico_nombre: tecnico,
    prueba: {
      tecnico: tecnico ? tecnicoReparacion(tecnico) : null,
      resolucion,
      tipo,
      tipologia: tipo === 'Preventivo' ? TIPOLOGIA_PREVENTIVO : TIPOLOGIA_CORRECTIVO,
    },
  }
}

async function main() {
  log(`\n=== Robot digitadores · ${ES_PROD ? 'PRODUCCIÓN' : 'QA'} · ${BASE} ${ESCRIBE_BANDEJA ? '' : '· Bandeja SOLO LECTURA'} ===`)
  if (PRUEBA) log('🧪 MODO PRUEBA: datos de prueba.json, sin Supabase')
  if (ES_PROD && !SOLO_LISTAR && !(await robotActivo())) {
    log('⏹️  "Robot digita Garantía" está APAGADO en Administración de Llamadas. No se procesa nada.')
    await latido('Apagado desde Administración')
    resumen('--- corrida sin llamadas (robot APAGADO en Administración)')
    return
  }
  let lista = PRUEBA ? llamadasDePrueba() : await candidatas(await estadoId())
  // Pendientes del robot por técnico: solo vuelven si el técnico YA aparece en el catálogo
  const esperando = []
  for (const a of lista) {
    if (!a.pendiente_en || !/^T[eé]cnico no identificado/i.test(a.pendiente_motivo || '')) continue
    try { a.datos = await datosLlamada(a) } catch (e) { a.datos = null; log(`   ⚠️ ${a.num_llamada}: no se pudo revisar (${e.message || e})`) }
    if (!a.datos?.tecnico) { a.saltar = true; esperando.push(`${a.num_llamada} ("${a.tecnico_nombre ?? ''}", centro ${a.centro_id}, catálogo ${a.datos?.catalogo ?? '?'})`) }
  }
  // Pendientes del robot por SKU: vuelven solo si ahora se pueden resolver solas (sin abrir CSHP para saberlo)
  const porSku = []
  for (const a of lista) {
    if (!a.pendiente_en || !/^El SKU no coincide/i.test(a.pendiente_motivo || '')) continue
    const skuCshp = (a.pendiente_motivo.match(/CSHP (\d+)/) || [])[1]
    const d = skuCshp ? await decisionSku(a.producto_sku, skuCshp).catch(() => ({})) : {}
    const resoluble = d.accion === 'mismo' || (d.accion === 'cambiar' && CAMBIAR_SKU_LISTO)
    if (!resoluble || /ya está/i.test(a.pendiente_motivo)) { a.saltar = true; porSku.push(a.num_llamada) }
  }
  if (porSku.length) log(`⏸️  Pendientes por SKU (revisión humana): ${porSku.join(', ')}`)
  if (esperando.length) log(`⏸️  Esperando técnico en el catálogo: ${esperando.join(', ')}`)
  lista = lista.filter((a) => !a.saltar).slice(0, MAX)
  log(`📋 ${lista.length} llamada(s) de ${ESTADO_BANDEJA} por procesar`)
  for (const a of lista) log(`   · ${a.num_llamada}  ${a.llamadas_centros?.nombre ?? ''}  ${a.tecnico_nombre ?? ''}  ${a.created_at ? new Date(a.created_at).toLocaleString('es-GT') : ''}`)
  if (!lista.length) { await latido('Sin llamadas de Garantía'); if (!SOLO_LISTAR) resumen('--- corrida sin llamadas') }
  if (SOLO_LISTAR || !lista.length) return

  if (!tomarLock()) { log('⏳ Otra corrida sigue activa (.sync.lock). Se sale.'); return }
  mon.trabajando(null, `${lista.length} llamada(s) por procesar`)
  const browser = await chromium.launch({ headless: !VISIBLE, slowMo: LENTO ? 250 : 0 })
  const page = await (await browser.newContext()).newPage()
  const cuenta = { digitada: 0, ya: 0, pendiente: 0, error: 0, tomada: 0 }
  try {
    await login(page)
    for (const a of lista) {
      const numero = a.num_llamada.toUpperCase()
      log(`\n▶️  ${numero}${a.datos ? '  (retomada: el técnico ya aparece en el catálogo)' : a.pendiente_en ? '  (reintento)' : ''}`)
      mon.trabajando(numero)
      if (!(await reservar(a))) { log('   ↪️ La tomó un digitador, se salta'); cuenta.tomada++; continue }
      try {
        cuenta[await procesar(page, a)]++
      } catch (e) {
        cuenta.error++
        const ruta = await captura(page, numero)
        const motivo = String(e.message || e).split('\n')[0]
        log(`   ❌ ${motivo}  (captura: ${ruta})`)
        anotar(QA_LLAMADA_CSHP || numero, 'error', { estado: 'error', motivo, captura: ruta })
        resumen(`${numero}  ERROR  ${motivo}`)
        const n = QA_LLAMADA_CSHP || numero
        const hechosAntes = pasosHechos(n).filter((p) => PASOS_CSHP.includes(p))
        if (!hechosAntes.length && errores(n) < MAX_INTENTOS) {
          await soltar(a)
          log(`   ↻ No se cambió nada en CSHP: se reintenta en la siguiente vuelta (intento ${errores(n)}/${MAX_INTENTOS})`)
        } else {
          await dejarPendiente(a, `${motivo} · subió ${await quienSubio(a)}${hechosAntes.length ? ` · En CSHP ya se hizo: ${hechosAntes.join(', ')}` : ` · No se cambió nada en CSHP (${MAX_INTENTOS} intentos)`}`)
        }
        if (/iniciar sesión/i.test(motivo)) break
      }
    }
  } finally {
    await browser.close().catch(() => {})
    try { unlinkSync(LOCK) } catch { /* ya no existe */ }
    const fin = `${cuenta.digitada} digitadas · ${cuenta.ya} ya digitadas · ${cuenta.pendiente} pendientes · ${cuenta.error} con error · ${cuenta.tomada} tomadas por digitadores`
    log(`\n✅ Fin: ${fin}`)
    resumen(`--- corrida: ${fin}`)
    await latido(fin, cuenta.error ? 'Hubo llamadas con error: revisar Pendientes' : null)
  }
}

main().catch(async (e) => { log(`❌ ${e.message || e}`); resumen(`--- corrida ERROR  ${String(e.message || e).split('\n')[0]}`); await latido('Error general', e.message || e).catch(() => {}); await mon.flush(); process.exitCode = 1 })

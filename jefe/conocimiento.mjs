/**
 * Conocimiento del Jefe para el chat libre (PRUEBA):
 *   · Catálogo Truper (truper\salida\truper_productos.json, ~15 mil productos) con buscador propio (BM25, sin internet)
 *   · Notas que Joshua le enseña ("/aprende …"): se buscan igual que el catálogo y la IA las usa como verdad
 * La IA local NO se re-entrena: lee lo que este buscador le encuentra en cada pregunta (así lo nuevo cuenta al instante).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs'

const CATALOGO = '../truper/salida/truper_productos.json'
const NOTAS = 'conocimiento/notas.json'
const HISTORIAL = 'conocimiento/historial.json'

const PARADAS = new Set('el la los las un una unos unas de del al a en con sin por para que y o u e es son se su sus lo le les me mi tu como cual cuales cuanto cuanta cuantos hay tiene tienen tengo quiero necesito sirve sirven busco buscar dame dime sobre algo mas muy este esta estos estas ese esa eso para pero si no ya cuál qué cómo dónde donde cuando cuándo the of and pesa pesan peso mide miden cuesta precio funciona funcionan recomiendas recomienda mejor diferencia entre usa usar uso tiene puedo puede'.split(' '))
const norm = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const raiz = (w) => (w.length > 5 && w.endsWith('es') ? w.slice(0, -2) : w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w)
export const palabras = (t) => norm(t).replace(/(\d)([a-z])/g, '$1 $2').replace(/([a-zñ])\/([a-zñ])/g, '$1 $2').split(/[^a-z0-9ñ./]+/).map((w) => w.replace(/^[./]+|[./]+$/g, '')).filter((w) => w && (w.length > 1 || /\d/.test(w)) && !PARADAS.has(w)).map(raiz)

/* ── Índice BM25 (en memoria; se arma una vez por proceso, ~1-2 s) ── */
let IDX = null
function indexar(docs) {
  const N = docs.length, df = new Map(), largos = [], tfs = []
  docs.forEach((d, i) => {
    const tf = new Map()
    const sumar = (txt, peso) => palabras(txt).forEach((w) => tf.set(w, (tf.get(w) || 0) + peso))
    sumar(d.nombre, 3); sumar(d.categoria, 2); sumar(d.marca, 1); sumar(d.extra, 1)
    tfs[i] = tf; largos[i] = [...tf.values()].reduce((a, b) => a + b, 0)
    for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1)
  })
  const prom = largos.reduce((a, b) => a + b, 0) / Math.max(1, N)
  const inv = new Map()
  tfs.forEach((tf, i) => tf.forEach((f, w) => { if (!inv.has(w)) inv.set(w, []); inv.get(w).push([i, f]) }))
  return { docs, N, df, inv, largos, prom }
}
const ACCESORIO = new Set(['repuesto', 'clip', 'cargador', 'llave', 'carburador', 'cadena', 'filtro', 'soporte', 'juego', 'boquilla', 'bolsa', 'kit', 'refaccion', 'cepillo', 'carbon', 'escobilla', 'empaque', 'tapa', 'manguera', 'adaptador', 'base', 'funda', 'estuche', 'disco', 'broca', 'hoja', 'lija', 'bateria', 'mango', 'cable', 'interruptor', 'caja', 'resorte', 'tornillo', 'perilla', 'engrane', 'rodamiento'].map(raiz))
function buscarEn(idx, consulta, k = 5) {
  const q = [...new Set(palabras(consulta))], puntos = new Map()
  for (const w of q) {
    const lista = idx.inv.get(w); if (!lista) continue
    const idf = Math.log(1 + (idx.N - idx.df.get(w) + 0.5) / (idx.df.get(w) + 0.5))
    for (const [i, f] of lista) puntos.set(i, (puntos.get(i) || 0) + idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * idx.largos[i] / idx.prom)))
  }
  // la máquina antes que sus accesorios: "taladro" → el taladro, no el clip del taladro (salvo que pidas el accesorio)
  for (const [i, p] of puntos) {
    const primera = palabras(idx.docs[i].nombre)[0]
    if (!primera) continue
    if (q.includes(primera)) puntos.set(i, p * 1.8)
    else if (ACCESORIO.has(primera)) puntos.set(i, p * 0.45)
  }
  return [...puntos.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([i, p]) => ({ ...idx.docs[i], puntos: p }))
}

function cargar() {
  if (IDX) return IDX
  const t0 = Date.now()
  let productos = []
  if (existsSync(CATALOGO)) productos = JSON.parse(readFileSync(CATALOGO, 'utf8')).filter((p) => p.nombre)
  const porCodigo = new Map()
  const docs = productos.map((p) => {
    const specs = (p.especificaciones || []).map((s) => `${s.nombre}: ${s.valor}`)
    const d = { tipo: 'producto', codigo: String(p.codigo || ''), clave: String(p.clave || ''), nombre: p.nombre, categoria: p.categoria || '', marca: p.marca || '',
      extra: [p.clave, ...specs, ...(p.caracteristicas || [])].join(' · '), specs, caract: p.caracteristicas || [], garantia: (p.garantia || [])[0] || '', empaque: p.empaque_individual || '', pagina: p.pagina || '' }
    porCodigo.set(d.codigo, d); if (d.clave) porCodigo.set(norm(d.clave), d)
    return d
  })
  IDX = { cat: indexar(docs), porCodigo, n: docs.length, fecha: existsSync(CATALOGO) ? statSync(CATALOGO).mtime : null }
  IDX.notas = indexar(leerNotas().map((n) => ({ tipo: 'nota', nombre: n.texto, categoria: '', marca: '', extra: '', ...n })))
  IDX.docs = indexar(leerDocs())
  console.log(`   catálogo: ${docs.length} productos · ${IDX.docs.N} secciones de documentación · ${Date.now() - t0} ms`)
  return IDX
}

/* Busca productos: primero código/clave exactos ("43041", "GCU-6BG"), después por palabras */
export function buscarProductos(texto, k = 5) {
  const idx = cargar(), exactos = []
  for (const m of String(texto).match(/\b\d{4,6}\b|\b[A-Z]{2,}[A-Z0-9]*-[A-Z0-9-]+\b/gi) || []) {
    const d = idx.porCodigo.get(m) || idx.porCodigo.get(norm(m)); if (d && !exactos.includes(d)) exactos.push(d)
  }
  return [...exactos, ...buscarEn(idx.cat, texto, k).filter((d) => !exactos.includes(d))].slice(0, k)
}
/* Documentación de TODOS los robots: CONTEXTO.md + README.md de cada carpeta, partida por secciones */
function leerDocs() {
  const out = [], archivos = [['General', '../CONTEXTO.md']]
  for (const d of readdirSync('..', { withFileTypes: true })) if (d.isDirectory() && existsSync(`../${d.name}/README.md`)) archivos.push([d.name, `../${d.name}/README.md`])
  for (const [robot, f] of archivos) {
    let seccion = robot, buf = []
    const cerrar = () => { const t = buf.join('\n').trim(); if (t.length > 40) for (let i = 0; i < t.length; i += 900) out.push({ tipo: 'doc', robot, nombre: `${robot} · ${seccion}`, categoria: robot, marca: '', extra: t.slice(i, i + 900), texto: t.slice(i, i + 900) }); buf = [] }
    for (const l of readFileSync(f, 'utf8').split(/\r?\n/)) { if (/^#{1,3}\s/.test(l)) { cerrar(); seccion = l.replace(/^#+\s*/, '') } else buf.push(l) }
    cerrar()
  }
  return out
}
export function buscarDocs(texto, k = 3) { return buscarEn(cargar().docs, texto, k).filter((d) => d.puntos > 2) }
export function buscarNotas(texto, k = 3) { return buscarEn(cargar().notas, texto, k).filter((n) => n.puntos > 1) }
export const infoCatalogo = () => { const i = cargar(); return { productos: i.n, fecha: i.fecha } }

/* Ficha compacta para la IA (poca memoria de trabajo: solo lo útil) */
export function ficha(d) {
  return [`[${d.codigo}] ${d.nombre} · clave ${d.clave} · marca ${d.marca} · categoría ${d.categoria}`,
    d.specs.length ? `  Especificaciones: ${d.specs.slice(0, 10).join('; ')}` : '', d.caract.length ? `  Características: ${d.caract.slice(0, 5).join('; ')}` : '',
    d.empaque ? `  Empaque: ${d.empaque}` : '', d.garantia ? `  Garantía: ${d.garantia.slice(0, 120)}` : ''].filter(Boolean).join('\n')
}

/* ── Notas que enseña Joshua ── */
function leerNotas() { try { return JSON.parse(readFileSync(NOTAS, 'utf8')) } catch { return [] } }
export function aprender(texto) {
  mkdirSync('conocimiento', { recursive: true })
  const notas = leerNotas(); notas.push({ id: Date.now(), texto: String(texto).trim(), fecha: new Date().toISOString() })
  writeFileSync(NOTAS, JSON.stringify(notas, null, 1))
  if (IDX) IDX.notas = indexar(notas.map((n) => ({ tipo: 'nota', nombre: n.texto, categoria: '', marca: '', extra: '', ...n })))
  return notas.length
}
export function listarNotas() { return leerNotas() }
export function olvidarNota(n) {
  const notas = leerNotas(); const [quitada] = notas.splice(n - 1, 1)
  if (quitada) writeFileSync(NOTAS, JSON.stringify(notas, null, 1))
  IDX && (IDX.notas = indexar(notas.map((x) => ({ tipo: 'nota', nombre: x.texto, categoria: '', marca: '', extra: '', ...x }))))
  return quitada
}

/* ── Historial de la conversación (para que entienda "¿y cuánto pesa?") ── */
export function leerHistorial() { try { return JSON.parse(readFileSync(HISTORIAL, 'utf8')) } catch { return [] } }
export function guardarTurno(pregunta, respuesta, codigos = []) {
  mkdirSync('conocimiento', { recursive: true })
  const h = leerHistorial().filter((t) => Date.now() - new Date(t.fecha).getTime() < 2 * 3600e3)   // la charla "caduca" a las 2 h
  h.push({ pregunta, respuesta, codigos, fecha: new Date().toISOString() })
  writeFileSync(HISTORIAL, JSON.stringify(h.slice(-6), null, 1))
}
export function borrarHistorial() { try { writeFileSync(HISTORIAL, '[]') } catch {} }

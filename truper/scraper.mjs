// Robot Catálogo Truper — extrae todos los productos de https://www.truper.com/CatVigente/
// a Excel, CSV y JSON (carpeta salida\). Solo HTTP + cheerio: sin navegador, sin IA.
//
// Flujo: 1) recorre las páginas del catálogo y junta los módulos (data-modulo)
//        2) pide a ficha/fichas los códigos y claves de cada módulo
//        3) descarga la ficha técnica de cada código   4) genera los archivos
//
// Uso:  node --env-file=.env scraper.mjs             corrida normal (retoma si se cortó)
//       node --env-file=.env scraper.mjs --nuevo     desde cero (borra lista y caché)
//       node --env-file=.env scraper.mjs --limit 20  prueba (no reporta al dungeon)
// La lista (codigos.json) y el caché se renuevan solos si tienen más de DIAS_REFRESCO días:
// la tarea mensual siempre trae el catálogo nuevo, y si se corta retoma donde iba.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cheerio from 'cheerio'
import ExcelJS from 'exceljs'
import { crearMonitor } from '../shared/monitor.mjs'
import { salirSiKardex } from '../shared/kardex-pausa.mjs'
await salirSiKardex('truper')   // pausa mientras Kardex actualiza inventario en esta PC

const DIR = path.dirname(fileURLToPath(import.meta.url))
const BASE = 'https://www.truper.com/CatVigente'
const FICHA_URL = 'https://www.truper.com/ficha_tecnica/controllers/index.php?codigo='
const IMG_URL = 'https://www.truper.com/admin/images/ch/'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const E = process.env
const DELAY_MS = Number(E.DELAY_MS || 800)        // pausa entre peticiones de cada worker
const CONCURRENCY = Number(E.CONCURRENCY || 3)    // fichas simultáneas
const DIAS_REFRESCO = Number(E.DIAS_REFRESCO || 20)
const MAX_ERROR_PCT = Number(E.MAX_ERROR_PCT || 2) // más de este % de fichas con error = la corrida termina en ERROR
const CACHE_DIR = path.join(DIR, 'cache')
const SALIDA = path.join(DIR, 'salida')
const LISTA = path.join(DIR, 'codigos.json')
const LOCK = path.join(DIR, '.truper.lock')

const args = process.argv.slice(2)
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity
const NUEVO = args.includes('--nuevo')
const PRUEBA = Number.isFinite(LIMIT)

// intervaloSeg 600: durante la corrida se reporta cada minuto; entre meses el dungeon lo trata como manual
const mon = crearMonitor('truper', { intervaloSeg: 600, activo: !PRUEBA })
let ultimoLatido = 0
const latido = (detalle, codigo = null, forzar = false) => {
  if (!forzar && Date.now() - ultimoLatido < 60000) return
  ultimoLatido = Date.now()
  mon.trabajando(codigo, detalle)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const clean = (s) => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim()
const hora = () => new Date().toLocaleTimeString('es-GT', { timeZone: 'America/Guatemala', hour12: false })
const duracion = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min` }

async function get(url, opts = {}, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(60000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.text()
    } catch (err) {
      if (i >= tries) throw new Error(`${url}: ${err.message}`)
      await sleep(2000 * i)
    }
  }
}

// ---------- 1. Páginas del catálogo y sus módulos ----------
async function crawlPages() {
  const queue = ['indice', '']
  const seen = new Set(queue)
  const modulos = new Map() // modulo -> { pagina, categoria, marca }
  while (queue.length) {
    const page = queue.shift()
    const $ = cheerio.load(await get(`${BASE}/${page}`))
    const categoria = clean($('.titulo_indice-2').first().text())
    $('[data-modulo]').each((_, el) => {
      const m = $(el).attr('data-modulo')
      if (m && !modulos.has(m)) modulos.set(m, { pagina: page ? `${BASE}/${page}` : BASE + '/', categoria, marca: marcaDePagina(page) })
    })
    $('a[href]').each((_, el) => {
      const m = $(el).attr('href').match(/^\.\/([^?#/]+\.html)$/)
      if (m && !seen.has(m[1])) { seen.add(m[1]); queue.push(m[1]) }
    })
    const hechas = seen.size - queue.length
    process.stdout.write(`\r  Páginas: ${hechas}/${seen.size}  módulos: ${modulos.size}   `)
    latido(`Páginas ${hechas}/${seen.size} · ${modulos.size} módulos`)
    await sleep(300)
  }
  console.log()
  return modulos
}

// "aceites-y-lubricantes-truper-18.html" -> "TRUPER". Se toma la última marca de la URL.
function marcaDePagina(page) {
  const marcas = (page || '').toLowerCase().match(/(?<=^|-)(truper|pretul|fiero|foset|hermex|klintek|volteck)(?=-|\.html)/g)
  return marcas ? marcas[marcas.length - 1].toUpperCase() : ''
}

// ---------- 2. Códigos por módulo ----------
async function fetchCodigos(modulos) {
  const ids = [...modulos.keys()]
  const productos = new Map()
  for (let i = 0; i < ids.length; i += 25) {
    const body = new URLSearchParams()
    ids.slice(i, i + 25).forEach((m) => body.append('modulos[]', m))
    const json = JSON.parse(await get(`${BASE}/ficha/fichas`, { method: 'POST', body, headers: { 'X-Requested-With': 'XMLHttpRequest' } }))
    for (const [modulo, html] of Object.entries(json)) {
      const $ = cheerio.load(html)
      $('.codes_mod li a').each((_, a) => {
        const codigo = clean($(a).find('.code').text())
        if (codigo && !productos.has(codigo)) productos.set(codigo, { codigo, clave: clean($(a).find('.sku').text()), modulo, ...modulos.get(modulo) })
      })
    }
    const n = Math.min(i + 25, ids.length)
    process.stdout.write(`\r  Módulos consultados: ${n}/${ids.length}  productos: ${productos.size}   `)
    latido(`Módulos ${n}/${ids.length} · ${productos.size} productos`)
    await sleep(300)
  }
  console.log()
  return [...productos.values()]
}

// ---------- 3. Ficha técnica (se guarda solo lo extraído, no el HTML de ~500 KB) ----------
async function fetchFicha(codigo) {
  const file = path.join(CACHE_DIR, `${codigo}.json`)
  if (fs.existsSync(file)) return { datos: JSON.parse(fs.readFileSync(file, 'utf8')), cache: true }
  const datos = parseFicha(await get(FICHA_URL + encodeURIComponent(codigo)))
  fs.writeFileSync(file, JSON.stringify(datos))
  await sleep(DELAY_MS)
  return { datos, cache: false }
}

// Dos plantillas de ficha: la nueva (clases ft-*) y la vieja (tabla_especs, text_fabricado...).
export function parseFicha(html) {
  const $ = cheerio.load(html)
  const uniq = (arr) => [...new Set(arr.filter(Boolean))]
  const nueva = $('.ft-product-name').length > 0

  const specs = [], vistos = new Set()
  const specRows = nueva ? $('.ft-specifications-table').first().find('tr.ft-specification-row') : $('tr#tabla_especs')
  specRows.each((_, tr) => {
    const celdas = $(tr).children('td, th')
    const nombre = clean(celdas.eq(0).text()), valor = clean(celdas.eq(1).text())
    if (nombre && !vistos.has(nombre)) { vistos.add(nombre); specs.push({ nombre, valor }) }
  })

  const empaque = {}
  const tablaEmpaque = nueva
    ? $('.ft-packaging-table-section').first().find('table')
    : $('table').filter((_, t) => /TIPO DE EMPAQUE/.test($(t).find('thead').text())).first()
  tablaEmpaque.find('tbody tr').each((_, tr) => {
    const celdas = $(tr).children('td, th')
    const k = clean(celdas.eq(0).text())
    if (k && !['Empaque logístico', 'Empaque'].includes(k) && !(k in empaque)) empaque[k] = clean(celdas.eq(1).text())
  })
  const empaqueIndividual = nueva
    ? clean($('.ft-packaging-table-section .title-table-greyblue').first().text()).replace(/^Empaque Individual:\s*/i, '')
    : empaque.Individual || ''
  delete empaque.Individual

  const tipos = [[/ficha-print\.php/, 'Ficha técnica'], [/descargables\/manual/, 'Manual de usuario'], [/hoja_seguridad/, 'Hoja de seguridad'], [/banco-contenido-digital/, 'Banco de fotos']]
  const descargas = {}
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href').replace(/^__DIR__\/(\.\.\/)+/, 'https://www.truper.com/')
    const tipo = tipos.find(([re]) => re.test(href))
    if (tipo && !descargas[tipo[1]]) descargas[tipo[1]] = href
  })

  const garantia = nueva ? $('.ft-certifications-body').first().find('.norm-gart-concep-text') : $('th.tamanio_th_norm_garant').next('td')
  return {
    nombre: clean((nueva ? $('.ft-product-name') : $('.tamanio_text_titulo p')).first().text()),
    caracteristicas: uniq((nueva ? $('.ft-product-concept p') : $('.body_especs p.lh-2, .body_especs_text p.lh-2')).map((_, p) => clean($(p).text())).get()),
    especificaciones: specs,
    empaque_individual: empaqueIndividual,
    empaque,
    garantia: uniq(garantia.map((_, d) => clean($(d).text())).get()),
    origen: clean((nueva ? $('.made-china') : $('.text_fabricado')).first().text()),
    descargas,
  }
}

async function scrapeFichas(productos) {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  let next = 0, done = 0, nuevas = 0
  const errores = []
  async function worker() {
    while (next < productos.length) {
      const p = productos[next++]
      try {
        const r = await fetchFicha(p.codigo)
        Object.assign(p, r.datos)
        if (!r.cache) nuevas++
      } catch (err) {
        p.error = err.message
        errores.push(p.codigo)
      }
      done++
      process.stdout.write(`\r  Fichas: ${done}/${productos.length}  errores: ${errores.length}   `)
      latido(`Fichas ${done}/${productos.length} · ${errores.length} errores`, p.codigo)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  console.log()
  return { errores, nuevas }
}

// ---------- 4. Salida ----------
async function guardar(productos) {
  fs.mkdirSync(SALIDA, { recursive: true })
  const filas = productos.map((p) => ({
    codigo: p.codigo,
    clave: p.clave,
    nombre: p.nombre || '',
    marca: p.marca || marcaDePagina(path.basename(p.pagina || '')),
    categoria: p.categoria,
    caracteristicas: (p.caracteristicas || []).join(' | '),
    especificaciones: (p.especificaciones || []).map((s) => `${s.nombre}: ${s.valor}`).join(' | '),
    empaque_individual: p.empaque_individual || '',
    inner: p.empaque?.Inner || '',
    master: p.empaque?.['Máster'] || '',
    pallet: p.empaque?.Pallet || '',
    origen: p.origen || '',
    garantia: (p.garantia || []).join(' | '),
    ficha_pdf: p.descargas?.['Ficha técnica'] || '',
    manual: p.descargas?.['Manual de usuario'] || '',
    hoja_seguridad: p.descargas?.['Hoja de seguridad'] || '',
    banco_fotos: p.descargas?.['Banco de fotos'] || '',
    imagen: IMG_URL + p.codigo + '.jpg',
    ficha_url: FICHA_URL + p.codigo,
    pagina_catalogo: p.pagina,
    modulo: p.modulo,
    error: p.error || '',
  }))

  const wb = new ExcelJS.Workbook()
  const hoja = wb.addWorksheet('Productos')
  hoja.columns = Object.keys(filas[0]).map((k) => ({ header: k, key: k, width: ['nombre', 'caracteristicas', 'especificaciones', 'garantia'].includes(k) ? 50 : 16 }))
  hoja.addRows(filas)
  hoja.getRow(1).font = { bold: true }
  hoja.views = [{ state: 'frozen', ySplit: 1 }]
  hoja.autoFilter = { from: 'A1', to: { row: 1, column: hoja.columns.length } }

  const hojaSpecs = wb.addWorksheet('Especificaciones')
  hojaSpecs.columns = [
    { header: 'codigo', key: 'codigo', width: 12 }, { header: 'clave', key: 'clave', width: 16 },
    { header: 'especificacion', key: 'nombre', width: 40 }, { header: 'valor', key: 'valor', width: 40 },
  ]
  for (const p of productos) for (const s of p.especificaciones || []) hojaSpecs.addRow({ codigo: p.codigo, clave: p.clave, ...s })
  hojaSpecs.getRow(1).font = { bold: true }
  hojaSpecs.views = [{ state: 'frozen', ySplit: 1 }]
  await wb.xlsx.writeFile(path.join(SALIDA, 'truper_catalogo.xlsx'))

  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const csv = [Object.keys(filas[0]).join(','), ...filas.map((f) => Object.values(f).map(esc).join(','))].join('\r\n')
  fs.writeFileSync(path.join(SALIDA, 'truper_productos.csv'), '﻿' + csv) // BOM: Excel lee bien los acentos
  fs.writeFileSync(path.join(SALIDA, 'truper_productos.json'), JSON.stringify(productos, null, 2))
}

// ---------- Candado: una sola corrida a la vez (la tarea mensual vs. una corrida a mano) ----------
function tomarCandado() {
  if (fs.existsSync(LOCK)) {
    const edad = Date.now() - fs.statSync(LOCK).mtimeMs
    if (edad < 6 * 3600000) return false
  }
  fs.writeFileSync(LOCK, String(process.pid))
  return true
}

async function main() {
  const t0 = Date.now()
  console.log(`=== ${new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' })} ${hora()} · Catálogo Truper${PRUEBA ? ` (prueba: ${LIMIT})` : ''}`)
  if (!PRUEBA && !tomarCandado()) { console.log('OMITIDA corrida: otra sigue en curso (.truper.lock)'); return }
  try {
    latido('Iniciando', null, true)
    const viejo = fs.existsSync(LISTA) && Date.now() - fs.statSync(LISTA).mtimeMs > DIAS_REFRESCO * 86400000
    if (NUEVO || viejo) {
      console.log(NUEVO ? 'Desde cero (--nuevo): borrando lista y caché.' : `Lista con más de ${DIAS_REFRESCO} días: se descarga el catálogo nuevo.`)
      fs.rmSync(CACHE_DIR, { recursive: true, force: true })
      fs.rmSync(LISTA, { force: true })
    }
    let productos
    if (fs.existsSync(LISTA)) {
      productos = JSON.parse(fs.readFileSync(LISTA, 'utf8'))
      console.log(`1-2) Usando lista guardada en codigos.json (${productos.length} productos).`)
    } else {
      console.log('1) Recorriendo páginas del catálogo...')
      const modulos = await crawlPages()
      if (!modulos.size) throw new Error('0 módulos: cambió el atributo data-modulo o las páginas del catálogo')
      console.log('2) Obteniendo códigos por módulo...')
      productos = await fetchCodigos(modulos)
      if (!productos.length) throw new Error('0 productos: cambió el endpoint ficha/fichas')
      fs.writeFileSync(LISTA, JSON.stringify(productos))
    }
    if (PRUEBA) productos = productos.slice(0, LIMIT)
    console.log(`3) Descargando ${productos.length} fichas técnicas...`)
    const { errores, nuevas } = await scrapeFichas(productos)
    console.log('4) Guardando archivos en salida\\ ...')
    latido('Guardando Excel, CSV y JSON', null, true)
    await guardar(productos)

    const sinNombre = productos.filter((p) => !p.error && !p.nombre).length
    const pct = (errores.length / productos.length) * 100
    const res = `${productos.length} productos · ${errores.length} errores · ${nuevas} fichas descargadas · ${duracion(Date.now() - t0)}`
    console.log(`Listo: ${res}${sinNombre ? ` · ${sinNombre} sin nombre (¿cambió la ficha?)` : ''}`)
    if (errores.length) console.log('Códigos con error (se reintentan en la próxima corrida):', errores.join(', '))
    errores.slice(0, 10).forEach((c) => mon.revisar(c, `Ficha ${c} con error: ${productos.find((p) => p.codigo === c)?.error || ''}`))
    if (pct > MAX_ERROR_PCT) mon.error(`${errores.length} de ${productos.length} fichas con error (${pct.toFixed(1)} %). Volver a correr correr.cmd: reintenta solo esas`)
    else if (sinNombre > productos.length * 0.05) mon.error(`${sinNombre} fichas sin nombre: Truper cambió el HTML de la ficha (revisar parseFicha)`)
    else mon.ok(null, `Catálogo descargado: ${res}`)
    mon.fin(`Sin pendientes · catálogo al día: ${res}`)
  } finally {
    if (!PRUEBA) fs.rmSync(LOCK, { force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then(() => mon.flush())
    .catch(async (err) => {
      console.error('ERROR', err)
      mon.error(err)
      await mon.flush()
      process.exit(1)
    })
}

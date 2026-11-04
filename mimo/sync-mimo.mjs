/**
 * MiMO (kiosco) → CSHP: crea la llamada de servicio de cada equipo en "Pendiente" (sync_status = 'listo',
 * es decir, ya revisado en el mostrador y con SKU).
 *
 * Flujo por equipo:
 *   1. Buscar cliente por teléfono (primer resultado ya filtrado) → si no hay, crear cliente
 *   2. Crear llamada: cliente + SKU + comentario (machote del mostrador), centro de servicio Zona 4
 *   3. Cambiar Status → Guía y Observaciones "MiMo-N" + "T - En Ruta" → Aceptar (llamada recién creada, aún abierta)
 *   4. Log tipo 1 con detalle "MiMo-N" → Aceptar → Guardar llamada
 *   5. Guardar el número de llamada en Supabase → "Completado" (pasa a "Por imprimir" en el mostrador)
 *
 * Uso (raíz del repo):  npm.cmd run sync         QA con navegador visible
 *                       npm.cmd run sync:buscar  QA, solo busca clientes
 *                       npm.cmd run sync:prod    producción
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { crearMonitor } from '../shared/monitor.mjs'
import { mkdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync, statSync } from 'node:fs'

// ─── Configuración ───────────────────────────────────────────────────────────
// Ambiente: --qa / --prod lo fuerzan (npm run sync / npm run sync:prod). Sin bandera usa AMBIENTE del .env (por defecto qa)
const PROD = process.argv.includes('--prod') || (!process.argv.includes('--qa') && /^prod/i.test(process.env.AMBIENTE || ''))
const BASE = ((PROD ? process.env.CSHP_PROD_URL : (process.env.CSHP_QA_URL || process.env.CSHP_URL))
  || (PROD ? 'https://taller.hpc.com.gt/CSHP' : 'https://tallerqa.hpc.com.gt/CSHP')).replace(/\/(Login\.aspx)?$/i, '')
// Usuario: en producción se puede usar uno distinto (CSHP_PROD_USUARIO / CSHP_PROD_PASSWORD); si no, el mismo de QA
const USUARIO = (PROD && process.env.CSHP_PROD_USUARIO) || process.env.CSHP_USUARIO
const PASSWORD = (PROD && process.env.CSHP_PROD_PASSWORD) || process.env.CSHP_PASSWORD
const MAX = Number(process.env.MAX_EQUIPOS || 20)
// Centro de servicio donde se crean las llamadas (CSHP trae por defecto el del usuario, p. ej. Guate Z5)
const CENTRO = (process.env.CSHP_CENTRO || 'Centro de Servicio Zona 4').trim()
// Minutos que un lote queda reservado para una corrida (y espera antes de reintentar un equipo con error)
const RESERVA_MIN = 30
const VISIBLE = process.argv.includes('--visible')
const SOLO_BUSCAR = process.argv.includes('--solo-buscar')
const ES_PROD = !/tallerqa/i.test(BASE)
// Solo estos números MiMo (ej. "12,13"). Útil en pruebas para no tocar registros reales
const mon = crearMonitor('mimo', { intervaloSeg: 600, activo: ES_PROD && !process.argv.includes('--solo-buscar') })
const SOLO_MIMO = String(process.env.SOLO_MIMO || '').split(',').map((x) => Number(x.trim())).filter(Boolean)

// Status al que pasa la llamada después de abrirla (texto de la lista de status/log en CSHP)
const ESTADO_RUTA = (process.env.CSHP_ESTADO_RUTA || 'T - En Ruta').trim()

// Filtro por teléfono en Clientes Centro Servicio (confirmado con la grabación en QA)
const SEL_FILTRO_TELEFONO = '#FrmClientesCS_TxtFTelefono'

for (const [k, v] of Object.entries({ CSHP_USUARIO: USUARIO, CSHP_PASSWORD: PASSWORD,
  SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY })) {
  if (!v) { console.error(`❌ Falta ${k} en .env`); process.exit(1) }
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// Errores que NO se reintentan solos: el equipo pasa a "Revisar" con el motivo
class ParaRevision extends Error {}

// ─── Utilidades ──────────────────────────────────────────────────────────────
/** "11888709" / "1188870 9" / "1188870-9" → "1188870-9".  CF → "CF".  Inválido → null */
export function normalizarNit(nit) {
  const t = String(nit ?? '').toUpperCase().replace(/[\s.\-]/g, '')
  if (t === 'CF' || t === 'C/F') return 'CF'
  if (!/^\d{1,12}[\dK]$/.test(t)) return null
  return `${t.slice(0, -1)}-${t.slice(-1)}`
}

/** Deja solo los 8 dígitos del número guatemalteco */
export function normalizarTelefono(tel) {
  const d = String(tel ?? '').replace(/\D/g, '')
  return d.length >= 8 ? d.slice(-8) : d
}

const ahora = () => new Date().toISOString()

/**
 * Clic en botones de CSHP (son <input type="image">). Si Playwright no puede hacer clic normal
 * en 5 s (el botón queda tapado o "inestable"), se hace clic por JavaScript, como en garantías.
 */
async function clic(page, selector) {
  try {
    await page.locator(selector).click({ timeout: 5_000 })
  } catch {
    await page.evaluate((s) => document.querySelector(s)?.click(), selector)
  }
}

async function actualizarEquipo(id, campos) {
  const { error } = await sb.from('mimo_equipos').update({ ...campos, last_sync_attempt_at: ahora() }).eq('id', id)
  if (error) console.error(`   ⚠️ No se pudo guardar en Supabase (${id}): ${error.message}`)
  return !error
}

// ─── CSHP: sesión ────────────────────────────────────────────────────────────
async function login(page) {
  // CSHP a veces no acepta el primer intento (página aún cargando): se reintenta hasta 3 veces
  for (let intento = 1; intento <= 3; intento++) {
    await page.goto(`${BASE}/Login.aspx`, { waitUntil: 'networkidle' }).catch(() => {})
    await page.locator('#FrmAcceso1_TxtUsuario').waitFor({ state: 'visible', timeout: 15_000 })
    await page.locator('#FrmAcceso1_TxtUsuario').fill(USUARIO)
    await page.locator('#FrmAcceso1_TxtPassword').fill(PASSWORD)
    await page.locator('#FrmAcceso1_TxtPassword').press('Enter')
    await page.waitForLoadState('networkidle')
    // Si Enter no envió el formulario, se usa el botón de ingresar
    if (/Login/i.test(page.url())) {
      const boton = page.locator('#FrmAcceso1 input[type=submit], #FrmAcceso1 input[type=image], #FrmAcceso1 button, input[type=submit][id*=Acceso], input[type=image][id*=Acceso], a[id*=Acceso][id*=Btn]').first()
      if (await boton.count()) { await boton.click().catch(() => {}); await page.waitForLoadState('networkidle').catch(() => {}) }
    }
    if (!/Login|BloqSeguridad/i.test(page.url())) { console.log('🔐 Sesión iniciada en CSHP'); return }
    // Qué respondió CSHP (mensaje en pantalla y página) para saber por qué no entró
    const motivo = await page.evaluate(() => {
      const t = [...document.querySelectorAll('span, div, td, label')]
        .filter((e) => e.offsetParent && e.children.length === 0)
        .map((e) => e.textContent.trim()).filter((x) => x && x.length < 200)
        .find((x) => /incorrect|inv[aá]lid|bloque|no existe|expir|activo|sesi[oó]n|intent|acceso|error/i.test(x))
      return t || ''
    }).catch(() => '')
    const pagina = page.url().split('/').pop().split('?')[0]
    console.warn(`   ⚠️ Inicio de sesión no aceptado (intento ${intento}/3) · página: ${pagina}${motivo ? ` · CSHP dice: "${motivo}"` : ''}`)
    await page.waitForTimeout(2000)
  }
  await page.screenshot({ path: 'capturas/login-fallido.png', fullPage: true }).catch(() => {})
  // Pistas sin mostrar la contraseña: largo y caracteres que el .env suele cortar (# espacios comillas)
  const pw = String(PASSWORD ?? '')
  console.warn(`   ℹ️ Contraseña leída del .env: ${pw.length} caracteres${/[#\s"'`$]/.test(pw) ? ' · contiene # espacio comillas o $ (ponla entre comillas simples en el .env)' : ''}`)
  throw new Error(`No se pudo iniciar sesión en CSHP con el usuario ${USUARIO} (revisa usuario/contraseña de ${PROD ? 'PRODUCCIÓN' : 'QA'}). Captura: worker\\capturas\\login-fallido.png`)
}

async function asegurarSesion(page) {
  if (/Login|BloqSeguridad/i.test(page.url())) await login(page)
}

/**
 * Antes de cada equipo: pregunta a CSHP (sin mover la página) si la sesión sigue viva.
 * Si venció, vuelve a entrar. Así un equipo no falla solo porque la sesión expiró.
 */
async function verificarSesion(page) {
  const r = await page.request.get(`${BASE}/LLamadasServ.aspx`, { maxRedirects: 0, timeout: 20_000 }).catch(() => null)
  let vencida = !r || /Login|BloqSeguridad/i.test(page.url())
  if (r && r.status() >= 300 && r.status() < 400) vencida ||= /Login|BloqSeguridad/i.test(r.headers()['location'] || '')
  else if (r && r.ok()) vencida ||= (await r.text().catch(() => '')).includes('FrmAcceso1_TxtUsuario')
  if (vencida) {
    console.log('   🔄 Sesión de CSHP vencida: entrando de nuevo')
    await login(page)
  }
}

// ─── Candado: una sola corrida a la vez en esta PC ───────────────────────────
const CANDADO = '.sync.lock'
const CANDADO_VIEJO_MS = 2 * 60 * 60_000 // 2 h: si quedó de una corrida que se cayó, se ignora

function procesoVivo(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/** true = candado tomado. false = ya hay otra corrida activa */
function tomarCandado() {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(CANDADO, 'wx')
      writeSync(fd, JSON.stringify({ pid: process.pid, inicio: ahora() }))
      closeSync(fd)
      const soltar = () => { try { unlinkSync(CANDADO) } catch { /* ya no existe */ } }
      process.on('exit', soltar)
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(130))
      return true
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let pid = 0
      try { pid = JSON.parse(readFileSync(CANDADO, 'utf8')).pid } catch { /* archivo dañado */ }
      const edad = Date.now() - statSync(CANDADO).mtimeMs
      if (pid && procesoVivo(pid) && edad < CANDADO_VIEJO_MS) return false
      console.warn('   🔓 Candado viejo de una corrida anterior: se elimina')
      try { unlinkSync(CANDADO) } catch { /* otro lo borró */ }
    }
  }
  return false
}

// ─── CSHP: clientes ──────────────────────────────────────────────────────────
async function abrirClientes(page) {
  await page.getByRole('link', { name: /Operaciones Taller/ }).first().click()
  await page.getByRole('link', { name: /Clientes Centro Servicio/ }).first().click()
  await page.waitForLoadState('networkidle')
  await asegurarSesion(page)
  await page.locator('#FrmClientesCS_TxtFNIT').waitFor({ state: 'visible', timeout: 15_000 })
}

/** Llena un filtro, busca y devuelve el primer código de cliente (HPCS…) o null */
async function buscarCon(page, selector, valor) {
  await abrirClientes(page)
  // Limpiar ambos filtros para que no se mezclen
  await page.locator('#FrmClientesCS_TxtFNIT').fill('')
  const tel = page.locator(SEL_FILTRO_TELEFONO)
  if (await tel.count()) await tel.fill('')
  await page.locator(selector).fill(valor)
  const buscar = page.getByRole('button', { name: 'Submit' }).first()
  if (await buscar.count()) await buscar.click()
  else await page.locator(selector).press('Enter')

  // CSHP filtra con una recarga parcial: se espera a que la tabla muestre SOLO resultados de lo buscado.
  // Si se lee antes, aparece la lista completa sin filtrar (así se tomó un cliente equivocado).
  const dig = (t) => String(t ?? '').replace(/\D/g, '')
  const coincide = (f) => (selector === SEL_FILTRO_TELEFONO ? dig(f.tel).includes(dig(valor)) : mismoNit(f.nit, valor))
  let filas = []
  for (let i = 0; i < 12; i++) {
    await esperarCSHP(page)
    filas = await leerFilasClientes(page)
    if (filas.length && filas.every(coincide)) return filas // tabla ya filtrada
    if (!filas.length && i >= 2) return [] // sin resultados
    await page.waitForTimeout(500)
  }
  // Nunca se filtró del todo: solo se usan las filas que sí coinciden
  return filas.filter(coincide)
}

/** Filas de la tabla de clientes: código (HPC… o HPCS…), nombre, NIT y teléfono (columnas por su encabezado) */
async function leerFilasClientes(page) {
  return page.evaluate(() => {
    const txt = (e) => (e?.innerText || '').replace(/\s+/g, ' ').trim()
    const filas = []
    for (const tr of document.querySelectorAll('tr')) {
      const celdas = [...tr.children].filter((c) => c.tagName === 'TD')
      const i = celdas.findIndex((c) => /^HPCS?\d+$/i.test(txt(c)))
      if (i < 0) continue
      const tabla = tr.closest('table')
      const enc = [...(tabla?.querySelectorAll('tr') ?? [])].map((f) => [...f.children].map(txt))
        .find((f) => f.some((t) => /^nit$/i.test(t)))
      const col = (re, def) => { const k = enc ? enc.findIndex((t) => re.test(t)) : -1; return txt(celdas[k >= 0 ? k : def]) }
      filas.push({ codigo: txt(celdas[i]).toUpperCase(), nombre: col(/^nombre/i, i + 1), nit: col(/^nit$/i, i + 2), tel: col(/tel/i, i + 3) })
    }
    return filas
  })
}

const palabras = (t) => sinAcentos(t).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !['s a', 'sociedad', 'anonima'].includes(w))
/** Mismo nombre: al menos 2 palabras en común (o todas las del nombre más corto, si tiene 1) */
function mismoNombre(a, b) {
  const pa = new Set(palabras(a)); const pb = palabras(b)
  const comunes = pb.filter((w) => pa.has(w)).length
  return comunes >= Math.min(2, pa.size, pb.length) && comunes > 0
}
const mismoNit = (a, b) => !!a && !!b && normalizarNit(a) === normalizarNit(b)

async function buscarCliente(page, reg) {
  const nit = normalizarNit(reg.nit)
  const tel = normalizarTelefono(reg.telefono)

  // Solo por teléfono (últimos 8 dígitos): el primer cliente de la tabla YA FILTRADA por ese teléfono
  // (buscarCon espera a que CSHP termine de filtrar, para no tomar uno de la lista completa)
  if (tel.length === 8) {
    const filas = await buscarCon(page, SEL_FILTRO_TELEFONO, tel)
    if (filas.length) {
      const f = filas[0]
      if (filas.length > 1) console.log(`   ℹ️ El teléfono ${tel} está en ${filas.length} clientes: se usa el primero`)
      return { codigo: f.codigo, por: `teléfono ${tel} · ${f.nombre} (NIT ${f.nit})` }
    }
  }

  // No existe: crearlo (en modo "solo buscar" solo se avisa)
  if (SOLO_BUSCAR) throw new ParaRevision(`No existe en CSHP: se crearía cliente nuevo (NIT ${nit ?? reg.nit}, tel. ${tel})`)
  const codigo = await crearCliente(page, reg, nit, tel)
  return { codigo, por: 'cliente nuevo' }
}

const sinAcentos = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()

/** Elige en un <select> la opción cuyo texto coincide (sin importar mayúsculas ni tildes) */
async function elegirOpcion(page, selector, texto, que) {
  const buscado = sinAcentos(texto)
  const opciones = await page.locator(`${selector} option`).evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent || '' })))
  const op = opciones.find((o) => sinAcentos(o.t) === buscado)
    || opciones.find((o) => o.v && sinAcentos(o.t).length > 3 && (sinAcentos(o.t).includes(buscado) || buscado.includes(sinAcentos(o.t))))
  if (!op) throw new ParaRevision(`No se encontró ${que} "${texto}" en CSHP para crear el cliente`)
  await page.locator(selector).selectOption(op.v)
}

/** "5a avenida 10-20, zona 1, Mixco, Guatemala" → { detalle, municipio, departamento } */
function partesDireccion(texto) {
  const p = String(texto ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  return { departamento: p.at(-1) ?? '', municipio: p.at(-2) ?? '', detalle: p.slice(0, -2).join(', ') || p.join(', ') }
}

async function crearCliente(page, reg, nit, tel) {
  const nombre = String(reg.nombre_entrega ?? '').trim().toUpperCase().slice(0, 100)
  const dir = partesDireccion(reg.direccion_envio)
  if (!nombre) throw new ParaRevision('No hay nombre para crear el cliente')
  if (tel.length !== 8) throw new ParaRevision(`Teléfono inválido para crear el cliente (${reg.telefono})`)

  await abrirClientes(page)
  await page.getByRole('button', { name: 'Agregar' }).click()
  await page.locator('#FrmClientesCS_TxtNIT').waitFor({ state: 'visible', timeout: 15_000 })

  await page.locator('#FrmClientesCS_TxtNIT').fill(nit && nit !== 'CF' ? nit : 'CF')
  await page.locator('#FrmClientesCS_TxtNombre').fill(nombre)
  await page.locator('#FrmClientesCS_TxtSociedad').fill(nombre)
  await page.locator('#FrmClientesCS_TxtDireccion').fill((dir.detalle || 'CIUDAD').toUpperCase().slice(0, 200))

  // Departamento → espera a que se carguen los municipios → municipio
  await elegirOpcion(page, '#FrmClientesCS_CmbEstado', dir.departamento, 'el departamento')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => (document.querySelector('#FrmClientesCS_CmbMunicipio')?.options.length ?? 0) > 1, null, { timeout: 10_000 })
  await elegirOpcion(page, '#FrmClientesCS_CmbMunicipio', dir.municipio, 'el municipio')

  await page.locator('#FrmClientesCS_TxtTelefono').fill(tel)
  await clic(page, '#FrmClientesCS_CmdAceptar')
  await page.waitForLoadState('networkidle')
  console.log(`   ➕ Cliente creado: ${nombre} (NIT ${nit ?? 'CF'}, tel. ${tel})`)

  // Obtener el código del cliente recién creado
  const porNit = nit && nit !== 'CF' ? (await buscarCon(page, '#FrmClientesCS_TxtFNIT', nit)).find((x) => mismoNit(x.nit, nit)) : null
  const porTel = porNit ? null : (await buscarCon(page, SEL_FILTRO_TELEFONO, tel)).find((x) => sinAcentos(x.nombre) === sinAcentos(nombre))
  const codigo = (porNit || porTel)?.codigo
  if (!codigo) throw new ParaRevision(`Se intentó crear el cliente (NIT ${nit ?? 'CF'}, tel. ${tel}) pero no aparece en la búsqueda. Revisar en CSHP`)
  return codigo
}

// ─── CSHP: llamada + log ─────────────────────────────────────────────────────
/**
 * Elige el centro de servicio (CENTRO) en el formulario de la llamada y confirma que quedó.
 * Busca la lista que tenga esa opción (sin importar mayúsculas, tildes ni espacios dobles).
 * Si no la encuentra, el mensaje muestra las opciones que sí vio para poder corregir CSHP_CENTRO.
 */
async function elegirCentro(page) {
  const r = await page.evaluate((buscado) => {
    const norm = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
    const objetivo = norm(buscado)
    const listas = [...document.querySelectorAll('select')]
    for (const el of listas) {
      const op = [...el.options].find((o) => norm(o.textContent) === objetivo)
        || [...el.options].find((o) => o.value && norm(o.textContent).endsWith(objetivo.replace(/^centro de servicio\s*/, '')) && /centro de servicio/.test(norm(o.textContent)))
      if (op) {
        const sel = el.id ? `select[id="${el.id}"]` : `select[name="${el.name}"]`
        return { sel, valor: op.value, texto: op.textContent.trim(), actual: (el.options[el.selectedIndex]?.textContent || '').trim(), deshabilitada: el.disabled }
      }
    }
    // No se encontró: devolver las opciones de las listas que parecen de centros, para diagnosticar
    const vistas = listas.filter((el) => [...el.options].some((o) => /centro|servicio|zona/i.test(o.textContent || '')))
      .map((el) => `${el.id || el.name}: ${[...el.options].map((o) => o.textContent.trim()).filter(Boolean).slice(0, 30).join(' | ')}`)
    return { error: vistas.join(' ;; ') || 'no hay listas de centros en la página' }
  }, CENTRO)

  if (r.error) throw new ParaRevision(`No se encontró "${CENTRO}" en la lista Centro de Servicio. Opciones vistas → ${r.error}`.slice(0, 900))
  if (r.actual === r.texto) return
  if (r.deshabilitada) throw new ParaRevision(`La lista Centro de Servicio está bloqueada en "${r.actual}"; no se puede cambiar a "${r.texto}"`)
  await page.locator(r.sel).selectOption(r.valor)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(800)
  const ahora = await page.locator(r.sel).evaluate((el) => (el.options[el.selectedIndex]?.textContent || '').trim())
  if (ahora !== r.texto) throw new Error(`No quedó seleccionado "${r.texto}" en Centro de Servicio (quedó "${ahora}")`)
}

async function crearLlamada(page, codigoCliente, equipo, reg) {
  await page.goto(`${BASE}/LLamadasServ.aspx`, { waitUntil: 'domcontentloaded' })
  await asegurarSesion(page)
  await page.locator('#FrmLLamadasServ_CmdNueva').click()
  await page.locator('#FrmLLamadasServ_TxtCliente').waitFor({ state: 'visible', timeout: 15_000 })

  // Cliente: escribir el código y elegirlo de la lista que aparece
  await page.locator('#FrmLLamadasServ_TxtCliente').fill(codigoCliente)
  await page.getByRole('cell', { name: codigoCliente, exact: true }).first().click({ timeout: 10_000 })
  await page.waitForLoadState('networkidle')

  // Centro de servicio (antes del SKU por si el cambio recarga el formulario)
  await elegirCentro(page)

  // SKU: al salir del campo CSHP recarga el formulario (postback); esperar antes de llenar lo demás
  await page.locator('#FrmLLamadasServ_TxtSKU').fill(equipo.sku)
  await page.locator('#FrmLLamadasServ_TxtSKU').press('Tab')
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1000)

  // Cantidad = 1 (verificar que no quede "11")
  const cant = page.locator('#FrmLLamadasServ_TxtCantidad')
  if (await cant.count()) {
    if ((await cant.inputValue()) !== '1') { await cant.fill(''); await cant.fill('1') }
    if ((await cant.inputValue()) !== '1') throw new Error(`Cantidad quedó en "${await cant.inputValue()}"`)
  }

  // Comentario: falla del cliente
  // Mismo formato que usa el mostrador (ACC queda vacío: lo llena el mostrador)
  const limpio = (t) => String(t ?? '').replace(/\s+/g, ' ').trim()
  const comentario = [
    `COMENTARIO: ${limpio(equipo.falla)}`,
    'ACC:',
    `INGRESA: ${limpio(reg.nombre_entrega).toUpperCase()}`,
    `DPI: ${limpio(reg.dpi_entrega)}`,
    `DIRECCIÓN: ${limpio(reg.direccion_envio)}`,
  ].join('\n').slice(0, 500)
  await llenarComentario(page, comentario)

  // Confirmar de nuevo el centro: un postback (SKU/comentario) lo puede regresar al del usuario
  await elegirCentro(page)
  console.log(`   🏢 ${CENTRO}`)

  if (SOLO_BUSCAR) return null

  // ─── A partir de aquí la llamada puede quedar creada: NUNCA reintentar automáticamente ───
  const numero = await aceptarYLeerNumero(page, comentario)
  return numero
}

/** Llena el comentario y confirma que quedó (un postback de CSHP lo puede borrar) */
async function llenarComentario(page, comentario) {
  const campo = page.locator('#FrmLLamadasServ_TxtComentario')
  for (let intento = 1; intento <= 3; intento++) {
    await campo.click()
    await campo.fill(comentario)
    // Salir del campo ANTES de presionar Aceptar: si no, el clic en Aceptar solo dispara
    // la recarga del campo (postback) y CSHP se queda esperando un segundo clic
    await campo.press('Tab')
    await esperarCSHP(page)
    if ((await campo.inputValue()).trim()) return
  }
  throw new Error('No se pudo escribir la descripción del problema en CSHP')
}

/** Espera a que CSHP termine de recargar (postback normal o parcial de ASP.NET) */
async function esperarCSHP(page) {
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
  await page.waitForFunction(() => {
    const prm = window.Sys?.WebForms?.PageRequestManager?.getInstance?.()
    return !prm || !prm.get_isInAsyncPostBack()
  }, null, { timeout: 15_000 }).catch(() => {})
  await page.waitForTimeout(700)
}

/**
 * Mensaje de error de CSHP, sin esperar. (innerText() espera hasta 30 s a que el elemento exista:
 * después de Guardar la llamada ya no está y el robot se quedaba "pensando" medio minuto)
 */
async function textoError(page) {
  const el = page.locator('#FrmLLamadasServ_LblError')
  if (!(await el.count().catch(() => 0))) return ''
  return el.first().innerText({ timeout: 1_000 }).catch(() => '')
}

async function leerNumero(page) {
  const el = page.locator('#FrmLLamadasServ_TxtCodigo')
  if (!(await el.count())) return null
  const t = ((await el.innerText().catch(() => '')) || (await el.inputValue().catch(() => ''))).trim()
  return t || null
}

async function aceptarYLeerNumero(page, comentario) {
  // En la grabación se necesitó presionar Aceptar dos veces (la primera valida el formulario)
  for (let intento = 1; intento <= 2; intento++) {
    if (!(await page.locator('#FrmLLamadasServ_TxtComentario').inputValue().catch(() => 'x')).trim()) {
      await llenarComentario(page, comentario)
    }
    console.log(`   ↳ Aceptar llamada (intento ${intento})`)
    await clic(page, '#FrmLLamadasServ_CmdAceptar')
    await esperarCSHP(page)
    try {
      await page.waitForFunction(() => {
        const el = document.querySelector('#FrmLLamadasServ_TxtCodigo')
        return el && ((el.textContent || '').trim() || (el.value || '').trim())
      }, null, { timeout: 10_000 })
      const n = await leerNumero(page)
      if (n) return n
    } catch { /* sigue al segundo intento */ }
    // CSHP rechazó el formulario (validación): la llamada NO se creó, se puede reintentar sin riesgo
    const validacion = (await textoError(page)).trim()
    if (validacion && !(await leerNumero(page))) throw new Error(`CSHP no aceptó la llamada: ${validacion}`)
  }
  const err = await textoError(page)
  throw new ParaRevision(`Se presionó Aceptar pero no apareció el número de llamada${err ? ` (${err.trim()})` : ''}. Verificar en CSHP antes de reintentar`)
}

/** MiMo-12 si el registro trae una herramienta; MiMo-12-1, MiMo-12-2… si trae varias (igual que en la app) */
const codigoMimo = (numero, orden, total) => `MiMo-${numero}${total > 1 ? `-${orden}` : ''}`

/**
 * Registra un log en la llamada abierta y presiona Guardar.
 * tipo: { valor: '1' } para el log normal, o { texto: 'T-En Ruta' } para elegir el status por su nombre.
 */
async function registrarLog(page, tipo, detalleTxt) {
  console.log(`   ↳ Log ${tipo.texto ?? `tipo ${tipo.valor}`} · ${detalleTxt}`)
  await clic(page, '#FrmLLamadasServ_CmdRegistrarLog')
  await esperarCSHP(page)
  const combo = page.locator('#FrmLLamadasServ_CmbTipoLog')
  await combo.waitFor({ state: 'visible', timeout: 10_000 })
  let valor = tipo.valor
  if (!valor) {
    const norm = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s\-_.]+/g, ' ').trim().toLowerCase()
    const buscado = norm(tipo.texto)
    const ops = await combo.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: (o.textContent || '').trim() })))
    const op = ops.find((o) => norm(o.t) === buscado) || ops.find((o) => o.v && norm(o.t).includes(buscado))
      || ops.find((o) => o.v && buscado.replace(/^t /, '') && norm(o.t).includes(buscado.replace(/^t /, '')))
    if (!op) throw new ParaRevision(`No se encontró el status "${tipo.texto}" en la lista del log. Opciones vistas → ${ops.map((o) => o.t).filter(Boolean).join(' | ')}`.slice(0, 900))
    valor = op.v
  }
  await combo.selectOption(valor)
  await esperarCSHP(page)
  const detalle = page.locator('#FrmLLamadasServ_TxtDetalleLog')
  await detalle.click()
  await detalle.fill(detalleTxt)
  await detalle.press('Tab') // salir del campo antes de Aceptar (mismo problema del postback)
  await esperarCSHP(page)
  await clic(page, '#FrmLLamadasServ_CmdAceptarLog')
  await esperarCSHP(page)
  // Si la ventana del log sigue abierta, el primer clic solo cerró la recarga: un clic más
  if (await detalle.isVisible().catch(() => false) && (await detalle.inputValue().catch(() => '')) === detalleTxt) {
    await clic(page, '#FrmLLamadasServ_CmdAceptarLog')
    await esperarCSHP(page)
  }
  const err = (await textoError(page)).trim()
  console.log('   ↳ Guardar llamada')
  await clic(page, '#FrmLLamadasServ_CmdAceptar')
  await esperarCSHP(page)
  const err2 = (await textoError(page)).trim()
  if (err2 && /error|no se|inv[aá]lid|no permit/i.test(err2)) throw new Error(`CSHP: ${err2}`)
  if (err && /error|no se|inv[aá]lid|no permit/i.test(err)) throw new Error(`CSHP: ${err}`)
}

/**
 * Botón "Cambiar Status" → ventana "Cambio de Status" → Nuevo Status = texto (p. ej. "T - En Ruta") → Aceptar.
 * Ids confirmados con la grabación en producción: CmdCambiarStatus, TxtGuiaStatus (Guía Recepción), CmbStatusN
 * (T - En Ruta = 101), TxtObservaciones y CmdAceptarCambio. En Guía y Observaciones va el código MiMo.
 */
async function cambiarStatus(page, texto, codigo) {
  console.log(`   ↳ Cambiar status → ${texto}`)
  const norm = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s\-_.]+/g, ' ').trim().toLowerCase()
  const buscado = norm(texto)

  await clic(page, '#FrmLLamadasServ_CmdCambiarStatus')
  await esperarCSHP(page)
  const combo = page.locator('#FrmLLamadasServ_CmbStatusN')
  await combo.waitFor({ state: 'visible', timeout: 15_000 })
    .catch(() => { throw new ParaRevision('No se abrió la ventana Cambio de Status (botón Cambiar Status)') })

  // Opción por su texto; si no aparece, el valor 101 (T - En Ruta en la grabación)
  const ops = await combo.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: (o.textContent || '').trim() })))
  const op = ops.find((o) => norm(o.t) === buscado) || ops.find((o) => o.v && norm(o.t).includes(buscado))
    || (buscado === 't en ruta' ? ops.find((o) => o.v === '101') : null)
  if (!op) throw new ParaRevision(`No aparece "${texto}" en Nuevo Status. Opciones → ${ops.map((o) => o.t).filter(Boolean).join(' | ')}`.slice(0, 900))
  // Guía Recepción = código MiMo (antes del status, como en la grabación)
  const guia = page.locator('#FrmLLamadasServ_TxtGuiaStatus')
  if (await guia.count()) await guia.fill(codigo)
  await combo.selectOption(op.v)
  await esperarCSHP(page)
  // Elegir el status puede recargar la ventana: confirmar la guía y llenar Observaciones
  if (await guia.count() && (await guia.inputValue().catch(() => '')) !== codigo) await guia.fill(codigo)
  const obs = page.locator('#FrmLLamadasServ_TxtObservaciones')
  if (await obs.count()) {
    await obs.fill(codigo)
    await obs.press('Tab')
    await esperarCSHP(page)
  }

  await clic(page, '#FrmLLamadasServ_CmdAceptarCambio')
  await esperarCSHP(page)
  // Si la ventana sigue abierta, el primer clic solo cerró una recarga: un clic más
  if (await combo.isVisible().catch(() => false)) {
    await clic(page, '#FrmLLamadasServ_CmdAceptarCambio')
    await esperarCSHP(page)
  }
  const err = (await textoError(page)).trim()
  if (err && /error|no se|inv[aá]lid|no permit|requer|obligat/i.test(err)) throw new Error(`CSHP: ${err}`)
  if (await combo.isVisible().catch(() => false)) throw new ParaRevision(`Se presionó Aceptar en Cambio de Status pero la ventana sigue abierta${err ? ` (${err})` : ''}`)
}

/** Cierra una ventana emergente de CSHP que haya quedado abierta (Escape o la X) */
async function cerrarVentana(page) {
  await page.keyboard.press('Escape').catch(() => {})
  await page.evaluate(() => {
    const x = [...document.querySelectorAll('a, button, input[type=image], img, span')]
      .find((e) => e.offsetParent && /^(x|×|cerrar|close)$/i.test((e.title || e.alt || e.textContent || '').trim()))
    x?.click()
  }).catch(() => {})
  await esperarCSHP(page)
}

/** Vuelve a abrir la llamada recién creada (para el segundo log) si CSHP regresó a la lista */
async function abrirLlamada(page, numero) {
  if (await page.locator('#FrmLLamadasServ_CmdRegistrarLog').isVisible().catch(() => false)) return
  await page.goto(`${BASE}/LLamadasServ.aspx`, { waitUntil: 'domcontentloaded' })
  await asegurarSesion(page)
  await esperarCSHP(page)
  const fila = page.getByRole('link', { name: numero, exact: true }).or(page.getByRole('cell', { name: numero, exact: true })).first()
  if (!(await fila.count())) throw new ParaRevision(`No se pudo volver a abrir la llamada ${numero} para pasarla a ${ESTADO_RUTA}`)
  await fila.click()
  await esperarCSHP(page)
  await page.locator('#FrmLLamadasServ_CmdRegistrarLog').waitFor({ state: 'visible', timeout: 15_000 })
}

/** Cuando no hay nada que procesar, explica por qué (filtro SOLO_MIMO, equipos en espera, etc.) */
async function explicarVacio(limite) {
  const { data: listos } = await sb.from('mimo_equipos')
    .select('orden, last_sync_attempt_at, sync_error, mimo_registros!inner(numero)')
    .eq('sync_status', 'listo').is('external_id', null)
  if (!listos?.length) {
    console.log('   ℹ️  Ningún equipo está en la pestaña "Pendiente" de la app.')
    console.log('      Revisa que el equipo tenga el SKU guardado (botón "Guardar SKU") y que no esté en "Revisar" (pestaña Todos).')
    return
  }
  if (SOLO_MIMO.length) console.log(`   ℹ️  El .env tiene SOLO_MIMO=${SOLO_MIMO.join(',')}: solo procesa esos MiMo. Déjalo vacío para procesar todos.`)
  for (const e of listos) {
    if (!e.last_sync_attempt_at || new Date(e.last_sync_attempt_at) < new Date(limite)) continue
    const hora = new Date(new Date(e.last_sync_attempt_at).getTime() + RESERVA_MIN * 60_000)
      .toLocaleTimeString('es-GT', { timeZone: 'America/Guatemala', hour: '2-digit', minute: '2-digit' })
    console.log(`   ⏱️  MiMo-${e.mimo_registros.numero} · equipo ${e.orden}: en espera hasta las ${hora}${e.sync_error ? ` (último error: ${e.sync_error})` : ' (otra corrida lo está procesando)'}`)
  }
  console.log('      Para reintentar ya: en la app presiona "Corregir SKU" y luego "Guardar SKU".')
}

// ─── Principal ───────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🚀 MiMO → CSHP  ·  ${ES_PROD ? '⚠️  PRODUCCIÓN' : 'QA'}  ·  ${BASE}${SOLO_BUSCAR ? '  ·  SOLO BUSCAR' : ''}${SOLO_MIMO.length ? `  ·  MiMo ${SOLO_MIMO.join(', ')}` : ''}\n`)

  // 1) Candado: si ya hay otra corrida en esta PC (tarea programada o manual), esta no hace nada
  if (!tomarCandado()) { console.log('⏸️  Ya hay otra corrida en proceso en esta PC. Se omite esta.'); return }
  mon.trabajando(null, 'Buscando pendientes')

  // Equipos en "Pendiente" que no estén tomados por otra corrida (reserva de 30 min)
  const limite = new Date(Date.now() - RESERVA_MIN * 60_000).toISOString()
  let consulta = sb.from('mimo_equipos')
    .select('id, orden, falla, sku, sync_retries, external_id, registro_id, mimo_registros!inner(id, numero, nit, telefono, nombre_entrega, dpi_entrega, direccion_envio, codigo_cliente, cantidad_equipos)')
    .eq('sync_status', 'listo')
    .is('external_id', null)
    .or(`last_sync_attempt_at.is.null,last_sync_attempt_at.lt.${limite}`)
    .order('revisado_at', { ascending: true })
    .limit(MAX)
  if (SOLO_MIMO.length) consulta = consulta.in('mimo_registros.numero', SOLO_MIMO)
  const { data: equipos, error } = await consulta
  if (error) throw new Error(`Supabase: ${error.message}`)
  if (!equipos?.length) {
    console.log('✅ No hay equipos pendientes.')
    mon.fin('Sin pendientes')
    await explicarVacio(limite)
    return
  }

  // 2) Reservar TODO el lote de una vez: otra corrida (aunque sea en otra PC) ya no los puede tomar.
  //    El UPDATE es condicional, así que si dos corridas compiten, cada equipo queda solo con una.
  const marca = ahora()
  const reservados = new Set()
  if (SOLO_BUSCAR) equipos.forEach((e) => reservados.add(e.id))
  else {
    const { data: tomados, error: errRes } = await sb.from('mimo_equipos')
      .update({ last_sync_attempt_at: marca })
      .in('id', equipos.map((e) => e.id))
      .eq('sync_status', 'listo')
      .is('external_id', null)
      .or(`last_sync_attempt_at.is.null,last_sync_attempt_at.lt.${limite}`)
      .select('id')
    if (errRes) throw new Error(`Supabase: ${errRes.message}`)
    tomados.forEach((t) => reservados.add(t.id))
  }
  const lote = equipos.filter((e) => reservados.has(e.id))
  if (!lote.length) { console.log('✅ Los pendientes ya los está procesando otra corrida.'); mon.fin('Pendientes tomados por otra corrida'); return }
  console.log(`📋 ${lote.length} equipo(s) pendiente(s)\n`)

  mkdirSync('capturas', { recursive: true })
  const browser = await chromium.launch({ headless: !VISIBLE, slowMo: VISIBLE ? 250 : 0 })
  const page = await (await browser.newContext()).newPage()
  // Ventanas emergentes de CSHP (confirmaciones/avisos): se aceptan solas para que el proceso no se detenga
  page.on('dialog', async (d) => { console.log(`   💬 CSHP: ${d.message()}`); await d.accept().catch(() => {}) })
  const clientes = new Map() // registro_id → código (una búsqueda por registro)

  try {
    await login(page)
    for (const eq of lote) {
      const reg = eq.mimo_registros
      const cod = codigoMimo(reg.numero, eq.orden, reg.cantidad_equipos)
      const etiqueta = `${cod} · SKU ${eq.sku}`
      console.log(`⏳ ${etiqueta}`)
      mon.trabajando(null, etiqueta)
      const inicioEq = Date.now()

      // Confirmar que la reserva sigue siendo de esta corrida y renovarla
      if (!SOLO_BUSCAR) {
        const { data: sigue } = await sb.from('mimo_equipos')
          .update({ last_sync_attempt_at: ahora() })
          .eq('id', eq.id).eq('last_sync_attempt_at', marca).eq('sync_status', 'listo').is('external_id', null)
          .select('id')
        if (!sigue?.length) { reservados.delete(eq.id); console.log('   ↪️  Ya lo tomó otra corrida, se salta'); continue }
      }
      reservados.delete(eq.id)

      // 3) Sesión de CSHP viva antes de empezar el equipo. Si no se puede entrar, se detiene la corrida
      //    sin gastar intentos: los equipos que faltan quedan libres para la siguiente.
      try {
        await verificarSesion(page)
      } catch (e) {
        console.error(`❌ ${e.message}. Se detiene la corrida.`)
        mon.error(e.message)
        if (!SOLO_BUSCAR) await sb.from('mimo_equipos').update({ last_sync_attempt_at: null }).eq('id', eq.id)
        break
      }

      let numero = null
      try {
        // 1. Cliente
        let codigo = clientes.get(reg.id) || reg.codigo_cliente
        if (!codigo) {
          const r = await buscarCliente(page, reg)
          codigo = r.codigo
          console.log(`   👤 Cliente ${codigo} (por ${r.por})`)
          if (!SOLO_BUSCAR) await sb.from('mimo_registros').update({ codigo_cliente: codigo }).eq('id', reg.id)
        } else {
          console.log(`   👤 Cliente ${codigo} (guardado)`)
        }
        clientes.set(reg.id, codigo)
        if (SOLO_BUSCAR) continue

        // 2. Llamada
        numero = await crearLlamada(page, codigo, eq, reg)
        console.log(`   🔑 Llamada ${numero}`)
        mon.trabajando(numero, etiqueta)
        // Guardar el número de inmediato: aunque falle el log, no se vuelve a crear
        await actualizarEquipo(eq.id, { external_id: numero, sync_status: 'needs_review', sync_error: `Llamada creada; registrando log ${cod}…` })

        // 3. Cambiar Status → "T - En Ruta" en la misma llamada, que sigue abierta después de Aceptar
        //    (si se guarda primero, CSHP cierra la llamada y hay que buscarla de nuevo en la lista)
        let errRuta = null
        try {
          await cambiarStatus(page, ESTADO_RUTA, cod)
          console.log(`   🚚 ${ESTADO_RUTA}`)
        } catch (e) {
          errRuta = e
          await page.screenshot({ path: `capturas/ruta-${cod}.png`, fullPage: true }).catch(() => {})
          await cerrarVentana(page)
        }

        // 4. Log tipo 1 con el número MiMo y Guardar la llamada
        try {
          await registrarLog(page, { valor: '1' }, cod)
        } catch (e) {
          await page.screenshot({ path: `capturas/log-${cod}.png` }).catch(() => {})
          await actualizarEquipo(eq.id, { sync_status: 'needs_review', sync_error: `Llamada ${numero} creada, pero falló el log ${cod}: ${e.message}${errRuta ? `. Tampoco se pasó a ${ESTADO_RUTA}` : ''}` })
          console.warn(`   ⚠️ Falló el log ${cod} — registrar a mano en la llamada ${numero}\n      Motivo: ${e.message}`)
          continue
        }

        if (errRuta) {
          await actualizarEquipo(eq.id, { sync_status: 'needs_review', sync_error: `Llamada ${numero} creada con log ${cod}, pero no se pudo pasar a ${ESTADO_RUTA}: ${errRuta.message}` })
          console.warn(`   ⚠️ No se pudo pasar a ${ESTADO_RUTA} — hacerlo a mano en la llamada ${numero}\n      Motivo: ${errRuta.message}\n      Captura: worker\\capturas\\ruta-${cod}.png`)
          continue
        }

        // 5. Completado
        await actualizarEquipo(eq.id, { sync_status: 'synced', synced_at: ahora(), sync_error: null })
        console.log(`   ✅ Completado (${Math.round((Date.now() - inicioEq) / 1000)} s)`)
        mon.ok(numero, etiqueta)
      } catch (e) {
        await page.screenshot({ path: `capturas/error-${cod}.png` }).catch(() => {})
        if (SOLO_BUSCAR) { console.warn(`   ⚠️ ${e.message}`); continue }
        if (numero || e instanceof ParaRevision) {
          await actualizarEquipo(eq.id, { sync_status: 'needs_review', sync_error: e.message })
          console.warn(`   🟠 Revisar: ${e.message}`)
          mon.revisar(numero, `${etiqueta} · ${e.message}`)
        } else {
          const intentos = (eq.sync_retries ?? 0) + 1
          await actualizarEquipo(eq.id, intentos >= 3
            ? { sync_status: 'rejected', sync_retries: intentos, sync_error: e.message }
            : { sync_retries: intentos, sync_error: e.message })
          console.error(`   ❌ Error (intento ${intentos}/3): ${e.message}`)
          mon.error(`${etiqueta} · intento ${intentos}/3 · ${e.message}`, numero)
        }
        await asegurarSesion(page).catch(() => {})
      }
    }
  } finally {
    // Liberar los equipos reservados que no se alcanzaron a procesar
    if (!SOLO_BUSCAR && reservados.size) {
      await sb.from('mimo_equipos').update({ last_sync_attempt_at: null })
        .in('id', [...reservados]).eq('last_sync_attempt_at', marca).eq('sync_status', 'listo')
    }
    await browser.close()
  }
  console.log('\n🏁 Terminado.')
  mon.fin('Corrida terminada')
}

main().catch((e) => { console.error('❌', e.message); mon.error(e.message); mon.flush().finally(() => process.exit(1)) })

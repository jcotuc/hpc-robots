/**
 * Crea en CSHP la llamada de servicio de cada equipo en estado "Pendiente" (sync_status = 'listo').
 *
 * Flujo por equipo:
 *   1. Buscar cliente: teléfono → (si no aparece) NIT → (si no aparece) crear cliente
 *   2. Crear llamada: cliente + SKU + comentario, tipología por defecto
 *   3. Registrar log "CITA"
 *   4. Guardar el número de llamada en Supabase → "Completado"
 *
 * Uso:   npm run qa            (sin ventana)
 *        npm run qa:visible    (con ventana, lento, para ver qué hace)
 *        npm run buscar        (solo busca clientes, no crea nada)
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { crearMonitor } from '../shared/monitor.mjs'
import { mkdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync, statSync, appendFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { salirSiKardex } from '../shared/kardex-pausa.mjs'
await salirSiKardex('citas')   // pausa mientras Kardex actualiza inventario en esta PC

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
// Solo estos IDs de cita (ej. "1001,1002"). Útil en pruebas para no tocar citas reales
const SOLO_CITAS = String(process.env.SOLO_CITAS || '').split(',').map((x) => Number(x.trim())).filter(Boolean)

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

// ─── Resumen legible: logs\resumen-AAAA-MM-DD.log (una línea por corrida y por equipo) ─────
const fechaGT = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' })
const horaGT = () => new Date().toLocaleTimeString('es-GT', { timeZone: 'America/Guatemala', hour12: false })
const INICIO = Date.now()
const AMB = () => (ES_PROD ? 'PROD' : 'QA')
const conteo = { creadas: [], revisar: [], error: [] }
const mon = crearMonitor('citas', { intervaloSeg: 300, activo: ES_PROD && !SOLO_BUSCAR })
function resumen(linea) {
  mon.linea(linea)
  try {
    mkdirSync('logs', { recursive: true })
    appendFileSync(`logs/resumen-${fechaGT()}.log`, `${horaGT()}  ${linea}\r\n`)
  } catch { /* el resumen nunca detiene el robot */ }
}
function finCorrida(extra = '') {
  const seg = Math.round((Date.now() - INICIO) / 1000)
  const partes = [`${conteo.creadas.length} creada(s)`]
  if (conteo.revisar.length) partes.push(`${conteo.revisar.length} a revisar`)
  if (conteo.error.length) partes.push(`${conteo.error.length} con error`)
  resumen(`--- corrida ${AMB()}${SOLO_BUSCAR ? ' (solo buscar)' : ''}: ${extra || partes.join(' · ')} (${seg} s)`)
  console.log(`\n📊 Resumen: ${extra || partes.join(' · ')}`)
  if (conteo.creadas.length) console.log(`   Creadas: ${conteo.creadas.join(', ')}`)
  if (conteo.revisar.length) console.log(`   Revisar: ${conteo.revisar.join(', ')}`)
  if (conteo.error.length) console.log(`   Error:   ${conteo.error.join(', ')}`)
}

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
  const { error } = await sb.from('cita_equipos').update({ ...campos, last_sync_attempt_at: ahora() }).eq('id', id)
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
const CANDADO_VIEJO_MS = 45 * 60_000 // 45 min: una corrida normal dura pocos minutos; más que eso = colgada o caída

/** true solo si el PID sigue vivo Y es node (Windows reutiliza PIDs: otro programa podía "tener" el candado) */
function procesoVivo(pid) {
  try { process.kill(pid, 0) } catch (e) { if (e.code !== 'EPERM') return false }
  if (process.platform !== 'win32') return true
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return /node\.exe/i.test(out)
  } catch { return true }
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
      if (pid && procesoVivo(pid) && edad < CANDADO_VIEJO_MS) {
        console.log(`   🔒 Candado de la corrida PID ${pid} (hace ${Math.round(edad / 60_000)} min). Si no hay otra corrida, borra worker\\.sync.lock`)
        return false
      }
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

/** Llena un filtro, busca y devuelve el código (HPCS…) de la fila que coincide con lo buscado, o null */
async function buscarCon(page, selector, valor) {
  await abrirClientes(page)
  // Limpiar ambos filtros para que no se mezclen
  await page.locator('#FrmClientesCS_TxtFNIT').fill('')
  const tel = page.locator(SEL_FILTRO_TELEFONO)
  if (await tel.count()) await tel.fill('')
  await page.locator(selector).fill(valor)
  // La pantalla usa UpdatePanel (AJAX): networkidle NO espera la búsqueda y se leía la lista vieja
  // (lista completa → primera fila HPCS000002). Se espera a que la tabla cambie de verdad.
  const firma = () => page.evaluate(() => [...document.querySelectorAll('tr')]
    .map((tr) => tr.innerText || '').filter((t) => /HPCS\d+/.test(t)).join('|'))
  const antes = await firma()
  await page.locator('#FrmClientesCS_CmdBuscar').click()
  const limite = Date.now() + 20_000
  let cambio = false
  while (Date.now() < limite) {
    await page.waitForTimeout(500)
    const ocupado = await page.evaluate(() => !!(window.Sys?.WebForms?.PageRequestManager?.getInstance()?.get_isInAsyncPostBack())).catch(() => true)
    if (!ocupado && (await firma()) !== antes) { cambio = true; break }
  }
  if (!cambio) throw new Error(`La búsqueda de cliente por "${valor}" no respondió en 20 s (la tabla no cambió)`)
  // Filas del resultado (una por cliente). NUNCA tomar "la primera" a ciegas: si el filtro no se aplicó,
  // CSHP muestra la lista completa y la primera fila es otro cliente (pasó con HPCS000002).
  const filas = await page.evaluate(() => [...document.querySelectorAll('tr')]
    .map((tr) => tr.innerText || '')
    .filter((t) => (t.match(/HPCS\d+/g) || []).length === 1))
  if (!filas.length) return null
  const norm = (t) => String(t).toUpperCase().replace(/[^0-9K]/g, '')
  const buscado = norm(valor)
  const fila = filas.find((t) => norm(t).includes(buscado))
  if (!fila) {
    // Cuando no hay coincidencias, CSHP muestra la lista completa (100 filas). Eso = "no existe por este dato".
    console.log(`   ℹ️  Búsqueda por "${valor}": ${filas.length} fila(s), ninguna coincide → no existe por este dato`)
    return null
  }
  return fila.match(/HPCS\d+/)[0]
}

async function buscarCliente(page, cita) {
  const nit = normalizarNit(cita.nit)
  const tel = normalizarTelefono(cita.telefono)

  // Solo por teléfono (últimos 8 dígitos). Por indicación del centro de servicio NO se busca por NIT:
  // si el teléfono no existe en CSHP, se crea un cliente nuevo.
  if (tel.length !== 8) throw new ParaRevision(`Teléfono inválido para buscar el cliente (${cita.telefono})`)
  const cod = await buscarCon(page, SEL_FILTRO_TELEFONO, tel)
  if (cod) return { codigo: cod, por: `teléfono ${tel}` }

  // No existe: crearlo (en modo "solo buscar" solo se avisa)
  if (SOLO_BUSCAR) throw new ParaRevision(`No existe en CSHP: se crearía cliente nuevo (NIT ${nit ?? cita.nit}, tel. ${tel})`)
  const codigo = await crearCliente(page, cita, nit, tel)
  return { codigo, por: 'cliente nuevo' }
}

const sinAcentos = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()

/** Diferencia en letras entre dos textos (para "Poptun" vs "Poptún", "San Jose" vs "San José", errores de 1-2 letras) */
function distancia(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}

/** Busca en las opciones de un <select>: igual → una contiene a la otra → parecida. Devuelve la opción o null */
function buscarOpcion(opciones, texto) {
  const buscado = sinAcentos(texto).replace(/\s+/g, ' ')
  const validas = opciones.filter((o) => o.v && sinAcentos(o.t))
  const n = (o) => sinAcentos(o.t).replace(/\s+/g, ' ')
  return validas.find((o) => n(o) === buscado)
    || validas.find((o) => n(o).length > 3 && (n(o).includes(buscado) || buscado.includes(n(o))))
    || validas.map((o) => ({ o, d: distancia(n(o), buscado) })).filter((x) => x.d <= 2).sort((a, b) => a.d - b.d)[0]?.o
    || null
}

const leerOpciones = (page, selector) => page.locator(`${selector} option`)
  .evaluateAll((os) => os.map((o) => ({ v: o.value, t: (o.textContent || '').trim() })))

/** Elige en un <select> la opción cuyo texto coincide (sin importar mayúsculas, tildes ni 1-2 letras) */
async function elegirOpcion(page, selector, texto, que) {
  const op = buscarOpcion(await leerOpciones(page, selector), texto)
  if (!op) throw new ParaRevision(`No se encontró ${que} "${texto}" en CSHP para crear el cliente`)
  await page.locator(selector).selectOption(op.v)
  return op.t
}

/**
 * Municipio: CSHP recarga la lista al cambiar el departamento; se espera hasta 15 s a que aparezca.
 * Si aun así no existe con ese nombre, se usa la cabecera/primer municipio del departamento para NO frenar la cita
 * (la dirección completa igual queda escrita en el cliente y en el comentario de la llamada).
 */
async function elegirMunicipio(page, selector, municipio, departamento) {
  let opciones = []
  for (let i = 0; i < 15; i++) {
    opciones = await leerOpciones(page, selector)
    const op = buscarOpcion(opciones, municipio)
    if (op) { await page.locator(selector).selectOption(op.v); return op.t }
    await page.waitForTimeout(1000)
  }
  const alterno = buscarOpcion(opciones, departamento) || opciones.find((o) => o.v && o.t)
  if (!alterno) throw new ParaRevision(`No se encontró el municipio "${municipio}" en CSHP (la lista de ${departamento} está vacía)`)
  await page.locator(selector).selectOption(alterno.v)
  console.warn(`   ⚠️ Municipio "${municipio}" no existe en CSHP para ${departamento}: se usó "${alterno.t}"`)
  return alterno.t
}

/** "5a avenida 10-20, zona 1, Mixco, Guatemala" → { detalle, municipio, departamento } */
function partesDireccion(texto) {
  const p = String(texto ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  const departamento = p.at(-1) ?? ''
  const municipio = p.at(-2) ?? ''
  const resto = p.slice(0, -2)
  // A veces llega "…, Poptún, Petén, Poptún, Petén": quitar la repetición
  while (resto.length >= 2 && sinAcentos(resto.at(-1)) === sinAcentos(departamento) && sinAcentos(resto.at(-2)) === sinAcentos(municipio)) resto.splice(-2)
  return { departamento, municipio, detalle: resto.join(', ') || p.join(', ') }
}

async function crearCliente(page, cita, nit, tel) {
  const nombre = String(cita.nombre_entrega ?? '').trim().toUpperCase().slice(0, 100)
  const dir = partesDireccion(cita.direccion_envio)
  if (!nombre) throw new ParaRevision('No hay nombre para crear el cliente')
  if (tel.length !== 8) throw new ParaRevision(`Teléfono inválido para crear el cliente (${cita.telefono})`)

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
  await elegirMunicipio(page, '#FrmClientesCS_CmbMunicipio', dir.municipio, dir.departamento)

  await page.locator('#FrmClientesCS_TxtTelefono').fill(tel)
  await clic(page, '#FrmClientesCS_CmdAceptar')
  await page.waitForLoadState('networkidle')
  console.log(`   ➕ Cliente creado: ${nombre} (NIT ${nit ?? 'CF'}, tel. ${tel})`)

  // Obtener el código del cliente recién creado
  const codigo = await buscarCon(page, SEL_FILTRO_TELEFONO, tel)
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

async function crearLlamada(page, codigoCliente, equipo, cita) {
  await page.goto(`${BASE}/LLamadasServ.aspx`, { waitUntil: 'domcontentloaded' })
  await asegurarSesion(page)
  await page.locator('#FrmLLamadasServ_CmdNueva').click()
  await page.locator('#FrmLLamadasServ_TxtCliente').waitFor({ state: 'visible', timeout: 15_000 })

  // Centro de servicio PRIMERO: cambiarlo recarga el formulario y puede reemplazar el cliente
  await elegirCentro(page)

  // Cliente: escribir el código y elegirlo de la lista que aparece
  await page.locator('#FrmLLamadasServ_TxtCliente').fill(codigoCliente)
  await page.getByRole('cell', { name: codigoCliente, exact: true }).first().click({ timeout: 10_000 })
  await esperarCSHP(page)
  await verificarCliente(page, codigoCliente, cita)

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

  // Comentario: ID de la cita + falla del cliente
  // Mismo formato que usa el mostrador (ACC queda vacío: lo llena el mostrador)
  const limpio = (t) => String(t ?? '').replace(/\s+/g, ' ').trim()
  const comentario = [
    `COMENTARIO: ${limpio(equipo.falla)}`,
    'ACC:',
    `INGRESA: ${limpio(cita.nombre_entrega).toUpperCase()}`,
    `DPI: ${limpio(cita.dpi_entrega)}`,
    `DIRECCIÓN: ${limpio(cita.direccion_envio)}`,
  ].join('\n').slice(0, 500)
  await llenarComentario(page, comentario)

  // Confirmar de nuevo el centro: un postback (SKU/comentario) lo puede regresar al del usuario
  await elegirCentro(page)
  console.log(`   🏢 ${CENTRO}`)
  // Último control antes de Aceptar: el cliente del formulario debe ser el de la cita
  await verificarCliente(page, codigoCliente, cita)

  if (SOLO_BUSCAR) return null

  // ─── A partir de aquí la llamada puede quedar creada: NUNCA reintentar automáticamente ───
  const numero = await aceptarYLeerNumero(page, comentario)
  return numero
}

/**
 * Doble check del cliente en el formulario de la llamada, antes de Aceptar:
 *   1. El único código HPCS… del formulario es el que se buscó.
 *   2. El NIT o el teléfono que CSHP muestra para ese cliente son los de la cita.
 * Si algo no cuadra, el equipo va a "Revisar" y la llamada NO se crea.
 */
async function verificarCliente(page, codigo, cita) {
  // CSHP carga los datos del cliente por AJAX (ruedita): esperar a que el teléfono o NIT aparezcan
  const leer = () => page.evaluate(() => [...document.querySelectorAll('input, span, td, textarea')]
    .map((e) => ((e.value ?? '') || (e.children.length ? '' : e.textContent) || '').trim())
    .filter(Boolean))
  const telCita = normalizarTelefono(cita.telefono)
  let valores = []
  for (let i = 0; i < 20; i++) {
    await esperarCSHP(page)
    valores = await leer()
    const unidos = valores.join(' ').replace(/[^0-9K]/gi, ' ')
    if (telCita && unidos.replace(/\s/g, '').includes(telCita)) break
    await page.waitForTimeout(1000)
  }
  const codigos = [...new Set(valores.filter((v) => /^HPCS\d+$/.test(v)))]
  const falla = async (motivo) => {
    await page.screenshot({ path: `capturas/cliente-${cita.numero}-${codigo}.png` }).catch(() => {})
    throw new ParaRevision(`${motivo}. No se creó la llamada`)
  }
  if (codigos.length !== 1 || codigos[0] !== codigo) {
    await falla(`El formulario tiene cliente ${codigos.join(', ') || '(vacío)'} y debía ser ${codigo}`)
  }
  const tel = normalizarTelefono(cita.telefono)
  // El teléfono puede venir con varios números ("42174065;41424173"): basta que uno sea el de la cita
  const telOk = tel.length === 8 && valores.some((v) => String(v).split(/[;,\/]|\s+o\s+|\s{2,}/i).some((p) => normalizarTelefono(p) === tel))
  if (!telOk) {
    await falla(`El cliente ${codigo} del formulario no tiene el teléfono ${tel} de la cita ${cita.numero}`)
  }
}

/**
 * Freno de seguridad: si este código de cliente ya se usó en otra cita con OTRO teléfono y OTRO NIT,
 * algo está mal (así se repitió HPCS000002). No se crea la llamada.
 */
async function revisarCodigoRepetido(codigo, cita) {
  const { data } = await sb.from('citas').select('numero, nit, telefono').eq('codigo_cliente', codigo).neq('id', cita.id).limit(50)
  const tel = normalizarTelefono(cita.telefono)
  const otras = (data ?? []).filter((c) => normalizarTelefono(c.telefono) !== tel)
  if (otras.length) {
    throw new ParaRevision(`El cliente ${codigo} ya se usó en la(s) cita(s) ${otras.map((c) => c.numero).join(', ')} con otro teléfono. Revisar antes de crear la llamada`)
  }
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
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForFunction(() => {
    const prm = window.Sys?.WebForms?.PageRequestManager?.getInstance?.()
    return !prm || !prm.get_isInAsyncPostBack()
  }, null, { timeout: 15_000 }).catch(() => {})
  await page.waitForTimeout(700)
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
    const validacion = (await page.locator('#FrmLLamadasServ_LblError').innerText().catch(() => '')).trim()
    if (validacion && !(await leerNumero(page))) throw new Error(`CSHP no aceptó la llamada: ${validacion}`)
  }
  const err = await page.locator('#FrmLLamadasServ_LblError').innerText().catch(() => '')
  throw new ParaRevision(`Se presionó Aceptar pero no apareció el número de llamada${err ? ` (${err.trim()})` : ''}. Verificar en CSHP antes de reintentar`)
}

async function registrarLogCita(page) {
  console.log('   ↳ Registrar log CITA')
  await clic(page, '#FrmLLamadasServ_CmdRegistrarLog')
  await esperarCSHP(page)
  await page.locator('#FrmLLamadasServ_CmbTipoLog').waitFor({ state: 'visible', timeout: 10_000 })
  await page.locator('#FrmLLamadasServ_CmbTipoLog').selectOption('1')
  await esperarCSHP(page)
  const detalle = page.locator('#FrmLLamadasServ_TxtDetalleLog')
  await detalle.click()
  await detalle.fill('CITA')
  await detalle.press('Tab') // salir del campo antes de Aceptar (mismo problema del postback)
  await esperarCSHP(page)
  console.log('   ↳ Aceptar log')
  await clic(page, '#FrmLLamadasServ_CmdAceptarLog')
  await esperarCSHP(page)
  // Si la ventana del log sigue abierta, el primer clic solo cerró la recarga: un clic más
  if (await detalle.isVisible().catch(() => false) && (await detalle.inputValue().catch(() => '')) === 'CITA') {
    await clic(page, '#FrmLLamadasServ_CmdAceptarLog')
    await esperarCSHP(page)
  }
  console.log('   ↳ Guardar llamada')
  await clic(page, '#FrmLLamadasServ_CmdAceptar')
  await esperarCSHP(page)
}

/** Cuando no hay nada que procesar, explica por qué (filtro SOLO_CITAS, equipos en espera, etc.) */
async function explicarVacio(limite) {
  const { data: listos } = await sb.from('cita_equipos')
    .select('orden, last_sync_attempt_at, sync_error, citas!inner(numero)')
    .eq('sync_status', 'listo').is('external_id', null)
  if (!listos?.length) {
    console.log('   ℹ️  Ningún equipo está en la pestaña "Pendiente" de la app.')
    console.log('      Revisa que el equipo tenga el SKU guardado (botón "Guardar SKU") y que no esté en "Revisar" (pestaña Todos).')
    return
  }
  if (SOLO_CITAS.length) console.log(`   ℹ️  El .env tiene SOLO_CITAS=${SOLO_CITAS.join(',')}: solo procesa esas citas. Déjalo vacío para procesar todas.`)
  for (const e of listos) {
    if (!e.last_sync_attempt_at || new Date(e.last_sync_attempt_at) < new Date(limite)) continue
    const hora = new Date(new Date(e.last_sync_attempt_at).getTime() + RESERVA_MIN * 60_000)
      .toLocaleTimeString('es-GT', { timeZone: 'America/Guatemala', hour: '2-digit', minute: '2-digit' })
    console.log(`   ⏱️  Cita ${e.citas.numero} · equipo ${e.orden}: en espera hasta las ${hora}${e.sync_error ? ` (último error: ${e.sync_error})` : ' (otra corrida lo está procesando)'}`)
  }
  console.log('      Para reintentar ya: en la app presiona "Corregir SKU" y luego "Guardar SKU".')
}

// ─── Principal ───────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🚀 Citas → CSHP  ·  ${ES_PROD ? '⚠️  PRODUCCIÓN' : 'QA'}  ·  ${BASE}${SOLO_BUSCAR ? '  ·  SOLO BUSCAR' : ''}${SOLO_CITAS.length ? `  ·  citas ${SOLO_CITAS.join(', ')}` : ''}\n`)

  // 1) Candado: si ya hay otra corrida en esta PC (tarea programada o manual), esta no hace nada
  if (!tomarCandado()) { console.log('⏸️  Ya hay otra corrida en proceso en esta PC. Se omite esta.'); resumen(`--- corrida ${AMB()}: OMITIDA, ya había otra corrida en proceso`); return }
  mon.trabajando(null, 'Buscando pendientes')

  // Equipos en "Pendiente" que no estén tomados por otra corrida (reserva de 30 min)
  const limite = new Date(Date.now() - RESERVA_MIN * 60_000).toISOString()
  let consulta = sb.from('cita_equipos')
    .select('id, orden, falla, sku, sync_retries, external_id, cita_id, citas!inner(id, numero, nit, telefono, nombre_entrega, dpi_entrega, direccion_envio, codigo_cliente)')
    .eq('sync_status', 'listo')
    .is('external_id', null)
    .or(`last_sync_attempt_at.is.null,last_sync_attempt_at.lt.${limite}`)
    .order('revisado_at', { ascending: true })
    .limit(MAX)
  if (SOLO_CITAS.length) consulta = consulta.in('citas.numero', SOLO_CITAS)
  const { data: equipos, error } = await consulta
  if (error) throw new Error(`Supabase: ${error.message}`)
  if (!equipos?.length) {
    console.log('✅ No hay equipos pendientes.')
    await explicarVacio(limite)
    finCorrida('sin equipos pendientes')
    return
  }

  // 2) Reservar TODO el lote de una vez: otra corrida (aunque sea en otra PC) ya no los puede tomar.
  //    El UPDATE es condicional, así que si dos corridas compiten, cada equipo queda solo con una.
  const marca = ahora()
  const reservados = new Set()
  if (SOLO_BUSCAR) equipos.forEach((e) => reservados.add(e.id))
  else {
    const { data: tomados, error: errRes } = await sb.from('cita_equipos')
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
  if (!lote.length) { console.log('✅ Los pendientes ya los está procesando otra corrida.'); finCorrida('pendientes tomados por otra corrida'); return }
  console.log(`📋 ${lote.length} equipo(s) pendiente(s)\n`)

  mkdirSync('capturas', { recursive: true })
  const clientes = new Map() // cita_id → código (una búsqueda por cita)
  let browser = null

  try {
    // Abrir el navegador DENTRO del try: si falla, el finally libera los equipos (antes quedaban 30 min trabados)
    browser = await chromium.launch({ headless: !VISIBLE, slowMo: VISIBLE ? 250 : 0 })
    const page = await (await browser.newContext()).newPage()
    // Ventanas emergentes de CSHP (confirmaciones/avisos): se aceptan solas para que el proceso no se detenga
    page.on('dialog', async (d) => { console.log(`   💬 CSHP: ${d.message()}`); await d.accept().catch(() => {}) })
    await login(page)
    for (const eq of lote) {
      const cita = eq.citas
      const etiqueta = `Cita ${cita.numero} · equipo ${eq.orden} · SKU ${eq.sku}`
      console.log(`⏳ ${etiqueta}`)
      mon.trabajando(null, etiqueta)

      // Confirmar que la reserva sigue siendo de esta corrida y renovarla
      if (!SOLO_BUSCAR) {
        const { data: sigue } = await sb.from('cita_equipos')
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
        if (!SOLO_BUSCAR) await sb.from('cita_equipos').update({ last_sync_attempt_at: null }).eq('id', eq.id)
        break
      }

      let numero = null
      try {
        // 1. Cliente
        let codigo = clientes.get(cita.id)
        if (!codigo) {
          const r = await buscarCliente(page, cita)
          codigo = r.codigo
          console.log(`   👤 Cliente ${codigo} (por ${r.por})`)
          if (!SOLO_BUSCAR) await sb.from('citas').update({ codigo_cliente: codigo }).eq('id', cita.id)
        } else {
          console.log(`   👤 Cliente ${codigo} (misma cita)`)
        }
        clientes.set(cita.id, codigo)
        if (SOLO_BUSCAR) {
          // Prueba sin riesgo: llena el formulario y corre el doble check, pero NO presiona Aceptar
          await revisarCodigoRepetido(codigo, cita)
          await crearLlamada(page, codigo, eq, cita)
          console.log('   ✔️  Formulario verificado (modo solo buscar: no se presionó Aceptar)')
          continue
        }

        // 2. Llamada
        await revisarCodigoRepetido(codigo, cita)
        numero = await crearLlamada(page, codigo, eq, cita)
        console.log(`   🔑 Llamada ${numero}`)
        mon.trabajando(numero, etiqueta)
        // Guardar el número de inmediato: aunque falle el log, no se vuelve a crear
        await actualizarEquipo(eq.id, { external_id: numero, sync_status: 'needs_review', sync_error: 'Llamada creada; registrando log CITA…' })

        // 3. Log "CITA"
        try {
          await registrarLogCita(page)
        } catch (e) {
          await page.screenshot({ path: `capturas/log-${cita.numero}-${eq.orden}.png` }).catch(() => {})
          await actualizarEquipo(eq.id, { sync_status: 'needs_review', sync_error: `Llamada ${numero} creada, pero falló el log CITA: ${e.message}` })
          console.warn(`   ⚠️ Falló el log CITA — registrar a mano en la llamada ${numero}`)
          conteo.revisar.push(`${numero} (cita ${cita.numero})`)
          resumen(`REVISAR ${numero}  cita ${cita.numero}-${eq.orden} · llamada creada, falta log CITA a mano`)
          continue
        }

        // 4. Completado
        await actualizarEquipo(eq.id, { sync_status: 'synced', synced_at: ahora(), sync_error: null })
        console.log(`   ✅ Completado`)
        conteo.creadas.push(`${numero} (cita ${cita.numero})`)
        resumen(`OK      ${numero}  cita ${cita.numero}-${eq.orden} · cliente ${clientes.get(cita.id)} · SKU ${eq.sku}`)
      } catch (e) {
        await page.screenshot({ path: `capturas/error-${cita.numero}-${eq.orden}.png` }).catch(() => {})
        if (SOLO_BUSCAR) { console.warn(`   ⚠️ ${e.message}`); continue }
        if (numero || e instanceof ParaRevision) {
          await actualizarEquipo(eq.id, { sync_status: 'needs_review', sync_error: e.message })
          console.warn(`   🟠 Revisar: ${e.message}`)
          conteo.revisar.push(`cita ${cita.numero}-${eq.orden}`)
          resumen(`REVISAR ${numero || '-'.padEnd(12)}  cita ${cita.numero}-${eq.orden} · ${e.message.split('\n')[0]}`)
        } else {
          const intentos = (eq.sync_retries ?? 0) + 1
          await actualizarEquipo(eq.id, intentos >= 3
            ? { sync_status: 'rejected', sync_retries: intentos, sync_error: e.message }
            : { sync_retries: intentos, sync_error: e.message })
          console.error(`   ❌ Error (intento ${intentos}/3): ${e.message}`)
          conteo.error.push(`cita ${cita.numero}-${eq.orden}`)
          resumen(`ERROR   ${'-'.padEnd(12)}  cita ${cita.numero}-${eq.orden} · intento ${intentos}/3 · ${e.message.split('\n')[0]}`)
        }
        await asegurarSesion(page).catch(() => {})
      }
    }
  } finally {
    // Liberar los equipos reservados que no se alcanzaron a procesar
    if (!SOLO_BUSCAR && reservados.size) {
      await sb.from('cita_equipos').update({ last_sync_attempt_at: null })
        .in('id', [...reservados]).eq('last_sync_attempt_at', marca).eq('sync_status', 'listo')
    }
    await browser?.close().catch(() => {})
  }
  finCorrida()
  console.log('\n🏁 Terminado.')
}

main().catch((e) => { resumen(`--- corrida ${AMB()}: FALLÓ · ${e.message.split('\n')[0]}`); console.error('❌', e.message); mon.flush().finally(() => process.exit(1)) })

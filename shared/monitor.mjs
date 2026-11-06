// monitor.mjs — reporta al Dungeon de Robots (Supabase: robot_status / robot_eventos).
// Mismo archivo en cada robot. NUNCA lanza errores ni detiene al robot.
// .env, modo A: MONITOR_SUPABASE_URL / MONITOR_SUPABASE_KEY = service_role (si faltan usa SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)
//       modo B (PC sin service_role): MONITOR_SUPABASE_URL, MONITOR_SUPABASE_KEY = anon key, MONITOR_TOKEN = token del robot
//       ROBOT_PC (opcional, nombre a mostrar) · MONITOR_APAGADO=1 para no reportar
//       ROBOT_CENTRO (opcional, ej. Nodus): centro de servicio. Requiere monitor/03_centros.sql
import os from 'node:os'

const LLAMADA_RE = /\bLL[A-Z]?\d+-\d+\b/i
const corto = (x) => String(x?.message || x || '').split('\n')[0].slice(0, 500)

export function crearMonitor(robot, { intervaloSeg = 180, activo = true } = {}) {
  // el .env se lee al crear el monitor (no al importar): así sirve también con dotenv
  const URL_ = (process.env.MONITOR_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '')
  const KEY = process.env.MONITOR_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  const TOKEN = (process.env.MONITOR_TOKEN || '').trim()
  const CENTRO = (process.env.ROBOT_CENTRO || '').trim()
  const PC = (process.env.ROBOT_PC || os.hostname()).trim().toUpperCase()
  const on = Boolean(activo && URL_ && KEY && process.env.MONITOR_APAGADO !== '1')
  let cola = Promise.resolve() // en orden: un "trabajando" nunca llega después del "esperando"
  let avisado = false
  let huboError = false

  const post = (path, body, prefer = 'return=minimal') => {
    if (!on) return
    cola = cola.then(async () => {
      try {
        const r = await fetch(`${URL_}/rest/v1/${path}`, {
          method: 'POST',
          headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: prefer },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        })
        if (!r.ok && !avisado) { avisado = true; console.log(`   [monitor] HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`) }
      } catch (e) {
        if (!avisado) { avisado = true; console.log(`   [monitor] no se pudo reportar: ${e.message}`) }
      }
    })
  }
  // Con token: todo pasa por la función robot_reportar (anon key). Sin token: escribe directo (service_role)
  const enviar = (tipo, body) => (TOKEN
    ? post('rpc/robot_reportar', { p_token: TOKEN, p_tipo: tipo, p_datos: body })
    : tipo === 'estado'
      ? post('robot_status?on_conflict=robot,pc', body, 'resolution=merge-duplicates,return=minimal')
      : post('robot_eventos', body))
  const estado = (est, detalle = null, llamada = null, err) => {
    const body = { robot, pc: PC, estado: est, detalle: detalle ? corto(detalle) : null, llamada, intervalo_seg: intervaloSeg }
    if (err !== undefined) body.ultimo_error = corto(err)
    if (CENTRO) body.centro = CENTRO
    enviar('estado', body)
  }
  const evento = (tipo, llamada = null, mensaje = null) =>
    enviar('evento', { robot, pc: PC, tipo, llamada, mensaje: mensaje ? corto(mensaje) : null, ...(CENTRO ? { centro: CENTRO } : {}) })

  const trabajando = (llamada = null, detalle = 'Procesando') => estado('trabajando', detalle, llamada)
  const ok = (llamada = null, mensaje = null) => evento('ok', llamada, mensaje)
  const revisar = (llamada = null, mensaje = null) => evento('info', llamada, mensaje)
  const error = (err, llamada = null) => { huboError = true; estado('error', corto(err), llamada, err); evento('error', llamada, corto(err)) }
  const fin = (detalle = 'Sin pendientes') => (huboError ? estado('error', detalle) : estado('esperando', detalle))

  /** Clasifica una línea del logs\resumen-*.log del robot y la reporta */
  function linea(texto) {
    const t = String(texto || '').trim()
    if (!t) return
    const ll = (t.match(LLAMADA_RE) || [])[0]?.toUpperCase() || null
    if (/^OMITIDA corrida/i.test(t)) return // otra corrida sigue: no tocar (así se detecta si se colgó)
    if (t.startsWith('---')) {
      const d = t.replace(/^-+\s*/, '')
      if (/OMITIDA/.test(d)) return
      if (/\bERROR\b|FALLÓ/.test(d)) return error(d)
      return fin(d)
    }
    if (/^OK\b/.test(t) || (/\bDIGITADA\b/.test(t) && !/YA DIGITADA/.test(t))) return ok(ll, t)
    if (/^ERROR\b/.test(t) || /\sERROR\s/.test(t)) return error(t, ll)
    return revisar(ll, t) // REVISAR, OMITIDA <llamada>, PENDIENTE, YA DIGITADA…
  }

  /** Esperar a que se envíe todo (antes de process.exit). Máx. 6 s */
  const flush = (ms = 6000) => Promise.race([cola, new Promise((r) => setTimeout(r, ms))])

  return { activo: on, trabajando, ok, revisar, error, fin, linea, flush }
}

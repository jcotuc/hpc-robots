/**
 * El Jefe en Telegram: avisa SOLO lo crítico al momento, manda resumen 7:00 y 18:00, responde comandos
 * y APRENDE de Joshua con botones (✅ causa correcta / ❌ no fue eso → "¿qué fue?").
 * Corre dentro de cada vuelta del Jefe (cada 3 min): los comandos se contestan en la siguiente vuelta.
 *
 * .env:  TELEGRAM_TOKEN=123:ABC (de @BotFather)   TELEGRAM_CHAT_ID=123456 (solo ese chat puede hablar con el Jefe)
 * Sacar el chat id:  node --env-file=.env telegram.mjs --chat   (antes escríbele /start al bot)
 */
import { readFileSync, writeFileSync } from 'node:fs'

const TOKEN = (process.env.TELEGRAM_TOKEN || '').trim()
const CHAT = (process.env.TELEGRAM_CHAT_ID || '').trim()
const ESTADO = 'telegram-estado.json'   // offset de mensajes, silencios, resúmenes enviados (local, no va a git)
export const telegramListo = () => Boolean(TOKEN && CHAT)

const leerEstado = () => { try { return JSON.parse(readFileSync(ESTADO, 'utf8')) } catch { return { offset: 0, silencio: {}, resumenes: {}, espera: null } } }
const guardarEstado = (e) => { try { writeFileSync(ESTADO, JSON.stringify(e, null, 1)) } catch { /* nunca detiene */ } }
export const h = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

async function api(metodo, cuerpo) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${metodo}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo), signal: AbortSignal.timeout(12000),
  })
  const j = await r.json().catch(() => ({}))
  if (!j.ok) throw new Error(`Telegram ${metodo}: ${j.description || r.status}`)
  return j.result
}
export async function enviar(texto, botones = null, chat = CHAT) {
  // Telegram corta en 4096 caracteres
  return api('sendMessage', { chat_id: chat, text: texto.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true,
    ...(botones ? { reply_markup: { inline_keyboard: botones } } : {}) })
}

/* ── Alerta crítica (una vez por hallazgo; respeta "silenciar 24 h") ── */
export async function alertaCritica(hz, id) {
  const est = leerEstado()
  const hasta = est.silencio?.[hz.clave]
  if (hasta && Date.now() < new Date(hasta).getTime()) return false
  const t = [`🚨 <b>${h(hz.titulo)}</b>`, hz.detalle && h(hz.detalle).slice(0, 600),
    hz.causa && `\n🔎 <b>Causa probable:</b> ${h(hz.causa)}`, hz.accion && `🛠 <b>Qué hacer:</b> ${h(hz.accion)}`,
    hz.aprendido && `🧠 ${h(hz.aprendido.split('\n')[0])}`].filter(Boolean).join('\n')
  const b = [[{ text: '👀 Visto', callback_data: `v|${id}` }, { text: '🔕 Silenciar 24 h', callback_data: `s|${id}` }]]
  if (hz.causa) b.push([{ text: '✅ Causa correcta', callback_data: `c+|${id}` }, { text: '❌ No fue eso', callback_data: `c-|${id}` }])
  await enviar(t, b)
  return true
}

/* ── Resumen 7:00 y 18:00 (avance del día) ── */
export async function quizasResumen(ctx) {
  const est = leerEstado(), p = horaGT_partes()
  const turno = p.min >= 18 * 60 ? 'tarde' : p.min >= 7 * 60 ? 'manana' : null
  if (!turno || p.dia === 0) return
  const clave = `${p.fecha}-${turno}`
  if (est.resumenes?.[clave]) return
  await enviar(await textoResumen(ctx, turno === 'manana' ? '☀️ Buenos días. Así amanecen los robots' : '🌙 Cierre del día'))
  est.resumenes = Object.fromEntries(Object.entries({ ...(est.resumenes || {}), [clave]: new Date().toISOString() }).slice(-20))
  guardarEstado(est)
}
async function textoResumen(ctx, titulo) {
  const { q, KK } = ctx, inicio = new Date(`${horaGT_partes().fecha}T00:00:00-06:00`).toISOString()
  const [res, carga, abiertos, cerradosHoy, nuevosHoy] = await Promise.all([
    q(KK, 'robot_resumen_hoy?select=*').catch(() => []), q(KK, 'robot_carga?select=*').catch(() => []),
    q(KK, 'jefe_hallazgos?select=clave,severidad,titulo,causa&cerrado_en=is.null').catch(() => []),
    q(KK, `jefe_hallazgos?select=id&cerrado_en=gte.${inicio}`).catch(() => []),
    q(KK, `jefe_hallazgos?select=id&abierto_en=gte.${inicio}`).catch(() => []),
  ])
  const porRobot = {}
  for (const r of res) { const x = (porRobot[r.robot] ||= { ok: 0, err: 0 }); x.ok += r.ok_hoy || 0; x.err += r.errores_hoy || 0 }
  const g = carga.find((c) => c.robot === 'garantias'); if (g?.hoy != null) (porRobot.garantias ||= { ok: 0, err: 0 }).ok = Math.max(porRobot.garantias.ok, g.hoy)
  const L = [`<b>${titulo}</b>`, '', '<b>Trabajo de hoy</b>']
  for (const [r, x] of Object.entries(porRobot).filter(([r]) => r !== 'jefe').sort((a, b) => b[1].ok - a[1].ok))
    L.push(`• ${h(ctx.NOMBRES[r] || r)}: ${x.ok} OK${x.err ? ` · ⚠️ ${x.err} errores` : ''}`)
  const pend = carga.filter((c) => c.pendientes > 0 && !c.robot.includes('@'))
  if (pend.length) { L.push('', '<b>Pendientes ahora</b>'); pend.forEach((c) => L.push(`• ${h(ctx.NOMBRES[c.robot] || c.robot)}: ${c.pendientes}`)) }
  const altas = abiertos.filter((a) => a.severidad === 'alta')
  L.push('', `<b>Alertas</b>: ${nuevosHoy.length} nuevas hoy · ${cerradosHoy.length} resueltas · ${abiertos.length} abiertas (${altas.length} críticas)`)
  altas.slice(0, 5).forEach((a) => L.push(`🚨 ${h(a.titulo)}${a.causa ? `\n   ↳ ${h(a.causa)}` : ''}`))
  const lg = ctx.resumenLogistica?.()
  if (lg) L.push('', lg)
  return L.join('\n')
}

/* ── Comandos y botones (se procesan en cada vuelta) ── */
export async function procesarMensajes(ctx) {
  const est = leerEstado()
  let ups = []
  try { ups = await api('getUpdates', { offset: est.offset || 0, timeout: 0, allowed_updates: ['message', 'callback_query'] }) } catch (e) { ctx.log(`Telegram: ${ctx.corto(e, 120)}`); return }
  for (const u of ups) {
    est.offset = u.update_id + 1
    try {
      if (u.callback_query) await boton(u.callback_query, est, ctx)
      else if (u.message?.text) await mensaje(u.message, est, ctx)
    } catch (e) { ctx.log(`Telegram (respuesta): ${ctx.corto(e, 150)}`) }
  }
  guardarEstado(est)
}
async function mensaje(m, est, ctx) {
  if (String(m.chat.id) !== CHAT) { ctx.log(`Telegram: mensaje de un chat no autorizado (${m.chat.id}), se ignora`); return }
  const t = m.text.trim(), cmd = t.split(/\s|@/)[0].toLowerCase()
  if (est.espera && !t.startsWith('/')) return enseñar(t, est, ctx)
  if (cmd === '/estado') return enviar(await textoEstado(ctx))
  if (cmd === '/alertas') return enviar(await textoAlertas(ctx))
  if (cmd === '/hoy') return enviar(await textoResumen(ctx, '📊 Cómo va el día'))
  if (cmd === '/aprendido') return enviar(await textoAprendido(ctx))
  return enviar('Soy el Jefe 👑. Te aviso solo lo crítico y a las 7:00 y 18:00 te mando el resumen.\n\n/estado · cómo están los robots\n/alertas · lo que está abierto y su causa\n/hoy · avance del día\n/aprendido · lo que ya sé\n\nRespondo cada ~3 min (cuando hago mi ronda).')
}
async function boton(cb, est, ctx) {
  if (String(cb.message?.chat?.id) !== CHAT) return
  const [acc, id] = String(cb.data || '').split('|')
  const hz = (await ctx.q(ctx.KK, `jefe_hallazgos?select=id,clave,titulo,patrones,causa&id=eq.${encodeURIComponent(id)}`).catch(() => []))[0]
  const responder = (txt) => api('answerCallbackQuery', { callback_query_id: cb.id, text: txt }).catch(() => {})
  if (!hz) return responder('Esa alerta ya no existe')
  if (acc === 'v') return responder('Anotado 👀')
  if (acc === 's') {
    est.silencio = { ...(est.silencio || {}), [hz.clave]: new Date(Date.now() + 24 * 3600e3).toISOString() }
    return responder('No te aviso de esto en 24 h 🔕')
  }
  if (acc === 'c+' || acc === 'c-') {
    for (const p of hz.patrones || []) await ctx.calificar(p, acc === 'c+')
    if (acc === 'c+') return responder('¡Bien! Le subo la confianza a esa causa ✅')
    est.espera = { patrones: hz.patrones || [], titulo: hz.titulo, hasta: new Date(Date.now() + 2 * 3600e3).toISOString() }
    await responder('Anotado ❌')
    return enviar(`🤔 Entonces, ¿qué fue lo que pasó en:\n<b>${h(hz.titulo)}</b>?\n\nEscríbeme la causa real (y si quieres, qué se hizo, separado con " → "). La próxima vez lo voy a decir así.`)
  }
}
async function enseñar(texto, est, ctx) {
  const e = est.espera; est.espera = null
  if (!e || Date.now() > new Date(e.hasta).getTime()) return enviar('Se me pasó el tiempo para esa alerta. Usa ❌ otra vez si quieres enseñarme.')
  const [causa, accion] = texto.split(/\s*→\s*|\s*->\s*/)
  for (const p of e.patrones) await ctx.enseñar(p, causa, accion || null)
  return enviar(`🧠 Aprendido. Cuando vuelva a pasar "${h(e.titulo)}" voy a decir:\n<b>${h(causa)}</b>${accion ? `\n🛠 ${h(accion)}` : ''}`)
}
async function textoEstado(ctx) {
  const filas = await ctx.q(ctx.KK, 'robot_status?select=robot,pc,centro,estado,detalle,last_seen').catch(() => [])
  const icon = { trabajando: '🟢', esperando: '🔵', error: '🔴' }
  const L = ['<b>Robots ahora</b>']
  for (const f of filas.filter((f) => f.robot !== 'jefe').sort((a, b) => a.robot.localeCompare(b.robot))) {
    const min = Math.round((Date.now() - new Date(f.last_seen).getTime()) / 60000)
    const viejo = min > 15 ? ` · ⚪ sin reportar hace ${min < 120 ? min + ' min' : Math.round(min / 60) + ' h'}` : ''
    L.push(`${viejo ? '⚪' : icon[f.estado] || '⚪'} ${h(ctx.NOMBRES[f.robot] || f.robot)}${f.centro ? ' · ' + h(f.centro) : ''}: ${h(ctx.corto(f.detalle, 60))}${viejo}`)
  }
  return L.join('\n')
}
async function textoAlertas(ctx) {
  const ab = await ctx.q(ctx.KK, 'jefe_hallazgos?select=severidad,titulo,causa,accion,abierto_en&cerrado_en=is.null&order=severidad.asc,abierto_en.asc').catch(() => [])
  if (!ab.length) return '✅ Sin alertas abiertas. Todo en orden.'
  return ['<b>Alertas abiertas</b>', ...ab.slice(0, 12).map((a) => `${a.severidad === 'alta' ? '🚨' : '🟡'} ${h(a.titulo)}${a.causa ? `\n   ↳ ${h(a.causa)}` : ''}${a.accion ? `\n   🛠 ${h(ctx.corto(a.accion, 140))}` : ''}`),
    ab.length > 12 ? `… y ${ab.length - 12} más` : ''].filter(Boolean).join('\n')
}
async function textoAprendido(ctx) {
  const m = await ctx.q(ctx.KK, 'jefe_aprendizaje?select=*&order=veces.desc&limit=10').catch(() => [])
  if (!m.length) return 'Todavía no he aprendido nada.'
  return ['<b>Lo que más se repite (y lo que sé)</b>', ...m.map((x) => {
    const votos = (x.confirmadas || 0) + (x.rechazadas || 0)
    const conf = votos ? ` · confianza ${Math.round(100 * (x.confirmadas || 0) / votos)}%` : ''
    return `• ${x.veces}× ${h(x.causa_joshua || x.causa || x.patron)}${x.causa_joshua ? ' <i>(me lo enseñaste)</i>' : ''}${conf}`
  })].join('\n')
}

function horaGT_partes() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Guatemala', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date()).map((x) => [x.type, x.value]))
  return { fecha: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute, dia: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) }
}

// node --env-file=.env telegram.mjs --chat  → muestra los chats que le escribieron al bot (para TELEGRAM_CHAT_ID)
if (process.argv.includes('--chat')) {
  if (!TOKEN) { console.log('Falta TELEGRAM_TOKEN en .env'); process.exit(1) }
  const ups = await api('getUpdates', { timeout: 0 })
  const chats = [...new Map(ups.filter((u) => u.message).map((u) => [u.message.chat.id, u.message.chat])).values()]
  if (!chats.length) console.log('No hay mensajes. Escríbele /start al bot en Telegram y vuelve a correr esto.')
  chats.forEach((c) => console.log(`TELEGRAM_CHAT_ID=${c.id}    (${c.first_name || ''} ${c.last_name || ''} ${c.username ? '@' + c.username : ''})`))
}

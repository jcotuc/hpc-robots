/**
 * El Jefe en Telegram (sin IA): alertas críticas al momento, resumen 7:00 y 18:00, conversación con palabras clave
 * y REGLAS que Joshua le enseña ("cuando … → causa: … → hacer: … → nivel: …"). El Jefe repite lo que entendió,
 * lo prueba contra las alertas de los últimos 30 días y solo la guarda si Joshua confirma.
 * Corre dentro de cada vuelta del Jefe (cada 3 min): responde en la siguiente vuelta.
 *
 * .env:  TELEGRAM_TOKEN (de @BotFather) · TELEGRAM_CHAT_ID (solo ese chat habla con el Jefe)
 * Chat id:  node --env-file=.env telegram.mjs --chat   (antes escríbele algo al bot)
 */
import { readFileSync, writeFileSync } from 'node:fs'

const TOKEN = (process.env.TELEGRAM_TOKEN || '').trim()
const CHAT = (process.env.TELEGRAM_CHAT_ID || '').trim()
const ESTADO = 'telegram-estado.json'   // offset, silencios, resúmenes enviados, regla por confirmar (local, no va a git)
export const telegramListo = () => Boolean(TOKEN && CHAT)

const leerEstado = () => { try { return JSON.parse(readFileSync(ESTADO, 'utf8')) } catch { return { offset: 0, silencio: {}, resumenes: {} } } }
const guardarEstado = (e) => { try { writeFileSync(ESTADO, JSON.stringify(e, null, 1)) } catch { /* nunca detiene */ } }
export const h = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const norm = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const LINEA = '━━━━━━━━━━━━━━━'
const barra = (n, max, w = 8) => { const k = max ? Math.round((n / max) * w) : 0; return '▰'.repeat(k) + '▱'.repeat(w - k) }
const hace = (d) => { const m = Math.round((Date.now() - new Date(d).getTime()) / 60000); return m < 1 ? 'ahora' : m < 60 ? `hace ${m} min` : m < 1440 ? `hace ${Math.round(m / 60)} h` : `hace ${Math.round(m / 1440)} d` }
const horaGT = (d) => new Date(d).toLocaleTimeString('es-GT', { timeZone: 'America/Guatemala', hour: '2-digit', minute: '2-digit', hour12: false })

async function api(metodo, cuerpo) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${metodo}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo), signal: AbortSignal.timeout(12000),
  })
  const j = await r.json().catch(() => ({}))
  if (!j.ok) throw new Error(`Telegram ${metodo}: ${j.description || r.status}`)
  return j.result
}
export async function enviar(texto, botones = null, chat = CHAT) {
  return api('sendMessage', { chat_id: chat, text: texto.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true,
    ...(botones ? { reply_markup: { inline_keyboard: botones } } : {}) })
}

/* ═════════════════ Vocabulario: robots, centros, llamadas ═════════════════ */
const ROBOTS = {
  digitadores: ['digitador', 'digitadores', 'digitacion', 'digitar', 'digi'], citas: ['cita', 'citas'], guias: ['guia', 'guias', 'impresion', 'imprimir'],
  correos: ['correo', 'correos', 'outlook', 'mail'], garantias: ['garantia', 'garantias', 'ndc', 'nota de credito', 'notas de credito'],
  truper: ['truper', 'catalogo'], kardex: ['kardex', 'inventario'], 'auditor-repuestos': ['auditor'], 'despacho-repuestos': ['despacho'],
  'solicitud-repuestos': ['solicitud'], jefe: ['jefe', 'tu', 'vos'],
}
const CENTROS = ['Nodus', 'Zona 4', 'Chimaltenango', 'Quiché', 'Escuintla', 'Río Hondo', 'Xela', 'Cobán', 'Huehuetenango', 'Mazatenango', 'Petén', 'Jutiapa', 'El Rancho', 'Morales']
const ALIAS_CENTRO = { 'zona 6': 'Nodus', z6: 'Nodus', z4: 'Zona 4', quetzaltenango: 'Xela', huehue: 'Huehuetenango', chimal: 'Chimaltenango', maza: 'Mazatenango', rancho: 'El Rancho' }
const palabra = (t, w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(t)
function entidades(texto) {
  const t = norm(texto)
  const robots = Object.entries(ROBOTS).filter(([id, al]) => id !== 'jefe' && al.some((a) => palabra(t, a))).map(([id]) => id)
  const centros = [...new Set([...CENTROS.filter((c) => palabra(t, norm(c))), ...Object.entries(ALIAS_CENTRO).filter(([a]) => palabra(t, a)).map(([, c]) => c)])]
  const llamadas = [...new Set((String(texto).match(/\bLL[SM]\d*-\d+\b/gi) || []).map((x) => x.toUpperCase()))]
  return { t, robots, centros, llamadas }
}

/* ═════════════════ Alerta crítica (una vez por hallazgo; respeta "silenciar 24 h") ═════════════════ */
export async function alertaCritica(hz, id) {
  const est = leerEstado(), hasta = est.silencio?.[hz.clave]
  if (hasta && Date.now() < new Date(hasta).getTime()) return false
  const t = [`🚨 <b>ALERTA CRÍTICA</b>`, LINEA, `<b>${h(hz.titulo)}</b>`, hz.detalle && `<i>${h(hz.detalle).slice(0, 500)}</i>`, '',
    hz.causa && `🔎 <b>Causa probable</b>\n<blockquote>${h(hz.causa)}</blockquote>`, hz.accion && `🛠 <b>Qué hacer</b>\n<blockquote>${h(hz.accion)}</blockquote>`,
    hz.aprendido && `🧠 <i>${h(hz.aprendido.split('\n')[0])}</i>`, `\n🤖 ${h(hz.robot || '—')}${hz.pc ? ' · ' + h(hz.pc) : ''} · ${horaGT(Date.now())}`].filter((x) => x !== undefined && x !== null && x !== false).join('\n')
  const b = [[{ text: '👀 Visto', callback_data: `v|${id}` }, { text: '🔕 24 h', callback_data: `s|${id}` }]]
  if (hz.causa) b.push([{ text: '✅ Esa es la causa', callback_data: `c+|${id}` }, { text: '❌ No fue eso', callback_data: `c-|${id}` }])
  await enviar(t, b)
  return true
}

/* ═════════════════ Resumen 7:00 y 18:00 ═════════════════ */
export async function quizasResumen(ctx) {
  const est = leerEstado(), p = partesGT()
  const turno = p.min >= 18 * 60 ? 'tarde' : p.min >= 7 * 60 ? 'manana' : null
  if (!turno || p.dia === 0) return
  const clave = `${p.fecha}-${turno}`
  if (est.resumenes?.[clave]) return
  await enviar(await textoResumen(ctx, turno === 'manana' ? '☀️ Buenos días, así amanecen los robots' : '🌙 Cierre del día'))
  est.resumenes = Object.fromEntries(Object.entries({ ...(est.resumenes || {}), [clave]: new Date().toISOString() }).slice(-20))
  guardarEstado(est)
}
async function textoResumen(ctx, titulo, filtro = {}) {
  const { q, KK } = ctx, inicio = new Date(`${partesGT().fecha}T00:00:00-06:00`).toISOString()
  const [res, carga, abiertos, cerradosHoy, nuevosHoy] = await Promise.all([
    q(KK, 'robot_resumen_hoy?select=*').catch(() => []), q(KK, 'robot_carga?select=*').catch(() => []),
    q(KK, 'jefe_hallazgos?select=clave,robot,severidad,titulo,causa&cerrado_en=is.null').catch(() => []),
    q(KK, `jefe_hallazgos?select=id&cerrado_en=gte.${inicio}`).catch(() => []), q(KK, `jefe_hallazgos?select=id&abierto_en=gte.${inicio}`).catch(() => []),
  ])
  const quiere = (r) => !filtro.robots?.length || filtro.robots.includes(r)
  const porRobot = {}
  for (const r of res) { if (r.robot === 'jefe' || !quiere(r.robot)) continue; const x = (porRobot[r.robot] ||= { ok: 0, err: 0 }); x.ok += r.ok_hoy || 0; x.err += r.errores_hoy || 0 }
  const g = carga.find((c) => c.robot === 'garantias'); if (g?.hoy != null && quiere('garantias')) (porRobot.garantias ||= { ok: 0, err: 0 }).ok = Math.max(porRobot.garantias.ok, g.hoy)
  const max = Math.max(1, ...Object.values(porRobot).map((x) => x.ok))
  const L = [`<b>${titulo}</b>`, LINEA, '📈 <b>Trabajo de hoy</b>']
  const filas = Object.entries(porRobot).sort((a, b) => b[1].ok - a[1].ok)
  if (!filas.length) L.push('<i>Sin movimiento todavía</i>')
  filas.forEach(([r, x]) => L.push(`<code>${barra(x.ok, max)}</code> ${h(ctx.NOMBRES[r] || r)} <b>${x.ok}</b>${x.err ? `  ⚠️ ${x.err} err` : ''}`))
  const pend = carga.filter((c) => c.pendientes > 0 && !c.robot.includes('@') && quiere(c.robot))
  if (pend.length) { L.push('', '⏳ <b>Pendientes ahora</b>'); pend.forEach((c) => L.push(`• ${h(ctx.NOMBRES[c.robot] || c.robot)}: <b>${c.pendientes}</b>`)) }
  const ab = abiertos.filter((a) => quiere(a.robot)), altas = ab.filter((a) => a.severidad === 'alta')
  L.push('', `🛎 <b>Alertas</b>  🆕 ${nuevosHoy.length} · ✅ ${cerradosHoy.length} resueltas · 📂 ${ab.length} abiertas${altas.length ? ` · 🚨 ${altas.length}` : ''}`)
  altas.slice(0, 4).forEach((a) => L.push(`🚨 ${h(a.titulo)}${a.causa ? `\n<blockquote>${h(a.causa)}</blockquote>` : ''}`))
  if (!filtro.robots?.length) { const lg = ctx.resumenLogistica?.(); if (lg) L.push('', lg) }
  return L.join('\n')
}

/* ═════════════════ Conversación ═════════════════ */
export async function procesarMensajes(ctx) {
  const est = leerEstado()
  let ups = []
  try { ups = await api('getUpdates', { offset: est.offset || 0, timeout: 0, allowed_updates: ['message', 'callback_query'] }) } catch (e) { ctx.log(`Telegram: ${ctx.corto(e, 120)}`); return }
  for (const u of ups) {
    est.offset = u.update_id + 1
    try {
      if (u.callback_query) await boton(u.callback_query, est, ctx)
      else if (u.message?.text) await mensaje(u.message, est, ctx)
    } catch (e) { ctx.log(`Telegram (respuesta): ${ctx.corto(e, 150)}`); await enviar(`😵 Me trabé contestando eso: <code>${h(ctx.corto(e, 120))}</code>`).catch(() => {}) }
  }
  guardarEstado(est)
}

async function mensaje(m, est, ctx) {
  if (String(m.chat.id) !== CHAT) { ctx.log(`Telegram: chat no autorizado (${m.chat.id}), se ignora`); return }
  const texto = m.text.trim(), e = entidades(texto), t = e.t, cmd = t.split(/\s|@/)[0]
  // ¿me estaba enseñando la causa real de una alerta?
  if (est.espera && !texto.startsWith('/') && Date.now() < new Date(est.espera.hasta).getTime()) return enseñarCausa(texto, est, ctx)
  // reglas
  if (cmd === '/reglas' || /^(mis )?reglas\b/.test(t)) return listarReglas(ctx)
  if (/^\/?regla\b/.test(t) || /→|->|=>/.test(texto) || (/^(cuando|si)\s/.test(t) && /(causa|hacer|nivel)\s*[:=]/.test(t))) return proponerRegla(texto, est, ctx)
  // comandos y frases
  if (cmd === '/ayuda' || cmd === '/start' || /^(ayuda|help|que puedes|que sabes hacer|comandos)/.test(t)) return enviar(textoAyuda())
  if (e.llamadas.length) return enviar(await textoLlamada(e.llamadas[0], ctx))
  if (cmd === '/aprendido' || /aprend|que sabes|memoria|recurrente/.test(t)) return enviar(await textoAprendido(ctx))
  if (cmd === '/alertas' || /alerta|problema|falla|error|que paso|que pasa|algo mal|critic|urgente/.test(t)) {
    if (/por ?que|causa|razon/.test(t)) return enviar(await textoPorque(e, ctx))
    return enviar(await textoAlertas(ctx, e))
  }
  if (/por ?que|causa|razon/.test(t)) return enviar(await textoPorque(e, ctx))
  if (cmd === '/hoy' || /hoy|resumen|cuant|productiv|avance|lleva|hicieron|trabajo|digitad[ao]s/.test(t)) return enviar(await textoResumen(ctx, e.robots.length ? `📊 ${e.robots.map((r) => ctx.NOMBRES[r] || r).join(', ')} hoy` : '📊 Cómo va el día', e))
  if (/pendiente|falta|cola|esperando|atras/.test(t)) return enviar(await textoPendientes(ctx, e))
  if (cmd === '/estado' || /estado|como (va|van|esta|estan)|que tal|funciona|trabajando|vivo|caido|corriendo/.test(t) || e.robots.length || e.centros.length) return enviar(await textoEstado(ctx, e))
  if (/^(hola|buen|que onda|hey|saludos)/.test(t)) return enviar(`👑 ¡Hola, Joshua!\n\n${await textoEstado(ctx, e, true)}\n\n<i>Pregúntame lo que quieras o escribe "ayuda".</i>`)
  if (/^(gracias|ok|listo|va|perfecto|excelente|vale|dale)\b/.test(t)) return enviar('👌 A la orden. Sigo vigilando.')
  return enviar(`🤔 No te entendí eso.\n\nPrueba con algo como:\n• <i>cómo va Cobán</i>\n• <i>pendientes de digitadores</i>\n• <i>por qué falló citas</i>\n• <i>LLM21-322408</i>\n• <i>cuando el error diga Outlook → causa: Outlook cerrado → hacer: abrir Outlook</i>\n\nO escribe <b>ayuda</b>.`)
}

function textoAyuda() {
  return [`👑 <b>Soy el Jefe</b>`, LINEA, 'Te aviso <b>solo lo crítico</b> y a las 7:00 y 18:00 te mando el resumen. Contesto en mi siguiente ronda (≤ 3 min).', '',
    '💬 <b>Pregúntame con tus palabras</b>', '• <i>cómo están los robots</i> · <i>cómo va Cobán</i>', '• <i>cuántas lleva digitadores hoy</i>', '• <i>pendientes de garantías</i>',
    '• <i>qué alertas hay</i> · <i>por qué falló citas</i>', '• <i>LLM21-322408</i> (te digo todo lo que sé de esa llamada)', '• <i>qué has aprendido</i>', '',
    '📏 <b>Enséñame una regla</b>', '<code>cuando [qué pasa] → causa: … → hacer: … → nivel: crítico | atención | ignorar</code>', 'Ejemplos:',
    '• <i>cuando el error diga "Outlook" → causa: Outlook cerrado → hacer: abrir Outlook en la PC de correos → nivel: atención</i>',
    '• <i>cuando digitadores de El Rancho diga "Técnico no identificado" → nivel: ignorar</i>',
    'Te repito lo que entendí y la pruebo con las alertas del último mes antes de guardarla.', '', '📋 <b>reglas</b> — ver y borrar las que me enseñaste'].join('\n')
}

async function textoEstado(ctx, e = {}, corto = false) {
  const filas = (await ctx.q(ctx.KK, 'robot_status?select=robot,pc,centro,estado,detalle,llamada,last_seen').catch(() => []))
    .filter((f) => f.robot !== 'jefe' && (!e.robots?.length || e.robots.includes(f.robot)) && (!e.centros?.length || e.centros.includes(f.centro)))
  if (!filas.length) return '🤷 No tengo reportes de eso.'
  const ICON = { trabajando: '🟢', esperando: '🔵', error: '🔴' }
  const grupos = {}
  for (const f of filas) (grupos[f.robot] ||= []).push(f)
  const viejo = (f) => (Date.now() - new Date(f.last_seen).getTime()) / 60000 > 15
  const L = [`🤖 <b>Robots ahora</b>${e.centros?.length ? ' · ' + h(e.centros.join(', ')) : ''}`, LINEA]
  for (const [r, fs] of Object.entries(grupos).sort()) {
    if (corto || fs.length > 3) {
      const c = { tr: fs.filter((f) => !viejo(f) && f.estado === 'trabajando').length, er: fs.filter((f) => !viejo(f) && f.estado === 'error').length, sin: fs.filter(viejo).length }
      L.push(`${c.er ? '🔴' : c.tr ? '🟢' : c.sin === fs.length ? '⚪' : '🔵'} <b>${h(ctx.NOMBRES[r] || r)}</b>${fs.length > 1 ? ` · ${fs.length} centros` : ''}${c.tr ? ` · ${c.tr} trabajando` : ''}${c.er ? ` · ${c.er} con error` : ''}${c.sin ? ` · ${c.sin} sin reportar` : ''}`)
    } else for (const f of fs) {
      L.push(`${viejo(f) ? '⚪' : ICON[f.estado] || '⚪'} <b>${h(ctx.NOMBRES[r] || r)}</b>${f.centro ? ' · ' + h(f.centro) : ''}`)
      L.push(`    ${h(ctx.corto(f.detalle, 70))}${f.llamada ? ` · <code>${h(f.llamada)}</code>` : ''} <i>(${hace(f.last_seen)})</i>`)
    }
  }
  return L.join('\n')
}
async function textoPendientes(ctx, e) {
  const c = (await ctx.q(ctx.KK, 'robot_carga?select=*').catch(() => [])).filter((x) => {
    const [r, cen] = x.robot.split('@')
    return (!e.robots.length || e.robots.includes(r)) && (e.centros.length ? e.centros.includes(cen) : !cen)
  })
  if (!c.length) return '🤷 No tengo esa carga.'
  const L = ['⏳ <b>Pendientes</b>', LINEA]
  c.sort((a, b) => (b.pendientes || 0) - (a.pendientes || 0)).forEach((x) => {
    const [r, cen] = x.robot.split('@')
    L.push(`${x.pendientes ? '🟡' : '✅'} <b>${h(ctx.NOMBRES[r] || r)}${cen ? ' · ' + h(cen) : ''}</b>: ${x.pendientes ?? '?'}  <i>${h(ctx.corto(x.detalle, 70))}</i>`)
  })
  return L.join('\n')
}
async function textoAlertas(ctx, e = {}) {
  const ab = (await ctx.q(ctx.KK, 'jefe_hallazgos?select=robot,centro,severidad,titulo,causa,accion,abierto_en&cerrado_en=is.null&order=severidad.asc,abierto_en.asc').catch(() => []))
    .filter((a) => (!e.robots?.length || e.robots.includes(a.robot)) && (!e.centros?.length || e.centros.includes(a.centro) || e.centros.some((c) => norm(a.titulo).includes(norm(c)))))
  if (!ab.length) return '✅ <b>Sin alertas abiertas</b>' + (e.robots?.length ? ' de eso' : '') + '. Todo en orden.'
  const altas = ab.filter((a) => a.severidad === 'alta'), medias = ab.filter((a) => a.severidad !== 'alta')
  const L = [`🛎 <b>Alertas abiertas</b>  🚨 ${altas.length} · 🟡 ${medias.length}`, LINEA]
  for (const a of [...altas, ...medias].slice(0, 10)) {
    L.push(`${a.severidad === 'alta' ? '🚨' : '🟡'} <b>${h(a.titulo)}</b> <i>(${hace(a.abierto_en)})</i>`)
    if (a.causa) L.push(`<blockquote>🔎 ${h(a.causa)}${a.accion ? `\n🛠 ${h(ctx.corto(a.accion, 160))}` : ''}</blockquote>`)
  }
  if (ab.length > 10) L.push(`<i>… y ${ab.length - 10} más</i>`)
  return L.join('\n')
}
/* "por qué falló X": la última alerta de ese robot (abierta o cerrada) con su investigación */
async function textoPorque(e, ctx) {
  const filtro = e.robots.length ? `&robot=in.(${e.robots.join(',')})` : ''
  const hs = await ctx.q(ctx.KK, `jefe_hallazgos?select=titulo,causa,accion,evidencia,aprendido,abierto_en,cerrado_en${filtro}&order=abierto_en.desc&limit=3`).catch(() => [])
  if (!hs.length) return `✅ No tengo fallas registradas${e.robots.length ? ' de ' + e.robots.map((r) => ctx.NOMBRES[r] || r).join(', ') : ''}.`
  const a = hs[0]
  return [`🔎 <b>Lo que encontré</b>`, LINEA, `<b>${h(a.titulo)}</b>`, `<i>${a.cerrado_en ? `✅ resuelta ${hace(a.cerrado_en)}` : `📂 abierta ${hace(a.abierto_en)}`}</i>`, '',
    a.causa ? `<b>Causa</b>\n<blockquote>${h(a.causa)}</blockquote>` : '🤷 Todavía no sé la causa.', a.accion ? `<b>Qué hacer</b>\n<blockquote>${h(a.accion)}</blockquote>` : '',
    a.evidencia ? `<b>Evidencia</b>\n<blockquote expandable>${h(ctx.corto(a.evidencia.replace(/\n/g, ' · '), 700))}</blockquote>` : '', a.aprendido ? `🧠 <i>${h(a.aprendido.split('\n')[0])}</i>` : ''].filter(Boolean).join('\n')
}
/* Todo lo que el Jefe sabe de una llamada */
async function textoLlamada(n, ctx) {
  const [evs, band, hs] = await Promise.all([
    ctx.q(ctx.KK, `robot_eventos?select=robot,tipo,mensaje,created_at&llamada=eq.${encodeURIComponent(n)}&order=id.desc&limit=8`).catch(() => []),
    ctx.CC ? ctx.q(ctx.CC, `llamadas_actualizaciones?select=tecnico_nombre,created_at,digitado_en,pendiente_motivo,producto_sku,llamadas_centros(nombre),llamadas_estados(nombre)&num_llamada=eq.${encodeURIComponent(n)}&limit=1`).catch(() => []) : [],
    ctx.q(ctx.KK, `jefe_hallazgos?select=titulo,causa,cerrado_en&or=(titulo.ilike.*${encodeURIComponent(n)}*,detalle.ilike.*${encodeURIComponent(n)}*)&order=id.desc&limit=3`).catch(() => []),
  ])
  const aud = ctx.leerAud?.()[n]
  const L = [`📞 <b>${h(n)}</b>`, LINEA]
  const b = band[0]
  if (b) L.push(`🗂 <b>Bandeja</b>: ${h(b.llamadas_estados?.nombre || '?')} · ${h(b.llamadas_centros?.nombre || '?')} · ${h(b.tecnico_nombre || '?')}${b.producto_sku ? ` · SKU ${h(b.producto_sku)}` : ''}`,
    b.digitado_en ? `    ✅ digitada ${hace(b.digitado_en)}` : b.pendiente_motivo ? `    🟡 pendiente: ${h(ctx.corto(b.pendiente_motivo, 120))}` : '    ⏳ sin digitar')
  if (evs.length) { L.push('', '🤖 <b>Lo que hicieron los robots</b>'); evs.forEach((x) => L.push(`${x.tipo === 'ok' ? '✅' : x.tipo === 'error' ? '❌' : 'ℹ️'} ${horaGT(x.created_at)} ${h(ctx.NOMBRES[x.robot] || x.robot)}: <i>${h(ctx.corto(String(x.mensaje || '').replace(n, '').trim(), 90))}</i>`)) }
  if (aud) L.push('', `🔍 <b>Auditoría Logística</b>: ${aud.estado === 'ok' ? '✅ bien' : '⚠️ ' + h(aud.razon || '')} · status ${h(aud.status || '?')}${aud.logistica ? `\n<blockquote>${h(aud.logistica)}</blockquote>` : ''}`)
  if (hs.length) { L.push('', '🛎 <b>Alertas</b>'); hs.forEach((x) => L.push(`${x.cerrado_en ? '✅' : '📂'} ${h(x.titulo)}${x.causa ? `\n<blockquote>${h(x.causa)}</blockquote>` : ''}`)) }
  if (L.length === 2) L.push('🤷 No tengo nada de esa llamada (ningún robot la ha tocado).')
  return L.join('\n')
}
async function textoAprendido(ctx) {
  const [m, reglas] = await Promise.all([ctx.q(ctx.KK, 'jefe_aprendizaje?select=*&order=veces.desc&limit=8').catch(() => []), cargarReglas(ctx)])
  const L = ['🧠 <b>Lo que he aprendido</b>', LINEA]
  if (!m.length) L.push('<i>Todavía nada.</i>')
  m.forEach((x) => {
    const votos = (x.confirmadas || 0) + (x.rechazadas || 0)
    const conf = votos ? ` · ${Math.round(100 * (x.confirmadas || 0) / votos)}% acierto` : ''
    L.push(`${x.veces >= 3 ? '🔁' : '•'} <b>${x.veces}×</b> ${h(x.causa_joshua || x.causa || x.patron)}${x.causa_joshua ? ' <i>(me lo enseñaste)</i>' : ''}${conf}`)
  })
  L.push('', `📏 <b>Reglas tuyas activas</b>: ${reglas.length}${reglas.length ? ' (escribe "reglas" para verlas)' : ''}`)
  return L.join('\n')
}

/* ═════════════════ Reglas que enseña Joshua ═════════════════ */
const NIVEL = { alta: '🚨 crítico', media: '🟡 atención', ignorar: '🔇 ignorar (no avisar)' }
function parsearRegla(texto) {
  const r = { robots: [], centros: [], textos: [], desde: null, hasta: null, causa: null, accion: null, nivel: null }
  const limpio = texto.replace(/^\s*\/?regla\s*:?\s*/i, '')
  const partes = limpio.split(/\s*(?:→|->|=>|;|\n)\s*/).filter(Boolean)
  const cond = []
  for (const p of partes) {
    const n = norm(p)
    let m
    if ((m = p.match(/^\s*(causa|porque|por que|motivo)\s*[:=]\s*(.+)$/i))) r.causa = m[2].trim()
    else if ((m = p.match(/^\s*(hacer|accion|acción|solucion|solución|que hacer|qué hacer)\s*[:=]\s*(.+)$/i))) r.accion = m[2].trim()
    else if ((m = n.match(/^\s*(nivel|prioridad|severidad)\s*[:=]?\s*(.+)$/))) r.nivel = /critic|alta|urgente|grave/.test(m[2]) ? 'alta' : /ignor|silenc|nada|no avis/.test(m[2]) ? 'ignorar' : /atenc|media|normal|baja/.test(m[2]) ? 'media' : r.nivel
    else if (/^(ignorar|ignoralo|no me avises|no avisar|silenciar)$/.test(n.trim())) r.nivel = 'ignorar'
    else cond.push(p)
  }
  const c = cond.join(' ')
  const e = entidades(c)
  r.robots = e.robots; r.centros = e.centros
  r.textos = [...c.matchAll(/["“”']([^"“”']{2,})["“”']/g)].map((x) => x[1].trim())
  if (!r.textos.length) {   // sin comillas: lo que va después de "diga / dice / contenga / mencione"
    const m = c.match(/\b(diga|dice|contenga|contiene|mencione|menciona|salga|aparezca)\s+(.+)$/i)
    if (m) r.textos = [m[2].replace(/^(que|el|la)\s+/i, '').trim()]
  }
  if (e.llamadas.length) r.textos.push(...e.llamadas)
  const hd = norm(c).match(/despues de las (\d{1,2})/), ha = norm(c).match(/antes de las (\d{1,2})/)
  if (hd) r.desde = +hd[1]; if (ha) r.hasta = +ha[1]
  return r
}
const condicionVacia = (r) => !r.robots.length && !r.centros.length && !r.textos.length && r.desde == null && r.hasta == null
export function reglaAplica(r, hz, horaActual = partesGT().min / 60) {
  const c = r.cuando || r
  const todo = norm([hz.titulo, hz.detalle, hz.causa, hz.clave, hz.pc, hz.centro].filter(Boolean).join(' '))
  if (c.robots?.length && !c.robots.includes(hz.robot)) return false
  if (c.centros?.length && !c.centros.some((x) => norm(hz.centro || '') === norm(x) || todo.includes(norm(x)))) return false
  if (c.textos?.length && !c.textos.every((x) => todo.includes(norm(x)))) return false
  if (c.desde != null && horaActual < c.desde) return false
  if (c.hasta != null && horaActual >= c.hasta) return false
  return true
}
function describir(r) {
  const c = r.cuando || r, cond = []
  if (c.robots?.length) cond.push(`robot <b>${c.robots.join(', ')}</b>`)
  if (c.centros?.length) cond.push(`centro <b>${h(c.centros.join(', '))}</b>`)
  if (c.textos?.length) cond.push(`el texto dice ${c.textos.map((x) => `“${h(x)}”`).join(' y ')}`)
  if (c.desde != null) cond.push(`después de las ${c.desde}:00`)
  if (c.hasta != null) cond.push(`antes de las ${c.hasta}:00`)
  const ent = []
  if (r.causa) ent.push(`🔎 causa: <i>${h(r.causa)}</i>`)
  if (r.accion) ent.push(`🛠 hacer: <i>${h(r.accion)}</i>`)
  if (r.nivel) ent.push(`📶 nivel: ${NIVEL[r.nivel]}`)
  return `<b>Cuando</b> ${cond.join(' · ')}\n<b>Entonces</b>\n${ent.map((x) => '  ' + x).join('\n')}`
}
async function proponerRegla(texto, est, ctx) {
  const r = parsearRegla(texto)
  const falta = []
  if (condicionVacia(r)) falta.push('🤔 No entendí <b>cuándo</b> aplica. Dime un robot, un centro o qué texto dice la alerta (entre comillas).')
  if (!r.causa && !r.accion && !r.nivel) falta.push('🤔 No entendí <b>qué hago</b> cuando pase. Usa <code>causa:</code>, <code>hacer:</code> o <code>nivel: crítico | atención | ignorar</code>.')
  if (falta.length) return enviar([`📏 <b>Casi…</b>`, LINEA, ...falta, '', 'Ejemplo:', '<i>cuando correos diga "Outlook" → causa: Outlook cerrado → hacer: abrir Outlook → nivel: atención</i>'].join('\n'))
  // Prueba: ¿a qué alertas del último mes le habría aplicado?
  const desde = new Date(Date.now() - 30 * 86400000).toISOString()
  const hist = await ctx.q(ctx.KK, `jefe_hallazgos?select=clave,robot,pc,centro,titulo,detalle,causa,abierto_en&abierto_en=gte.${desde}&order=abierto_en.desc&limit=1000`).catch(() => [])
  const aplica = hist.filter((x) => reglaAplica({ cuando: r }, x, 12))   // la hora no se prueba en el historial
  const L = [`📏 <b>Entendí esta regla</b>`, LINEA, describir(r), '', `🧪 <b>Prueba con el último mes</b> (${hist.length} alertas)`]
  if (!aplica.length) L.push('<i>No habría aplicado a ninguna. Puede ser algo nuevo, o que el texto no coincide con cómo escribo las alertas.</i>')
  else {
    L.push(`Habría aplicado a <b>${aplica.length}</b>:`); aplica.slice(0, 3).forEach((x) => L.push(`• <i>${h(ctx.corto(x.titulo, 90))}</i>`))
    if (hist.length > 10 && aplica.length / hist.length > 0.4) L.push(`⚠️ <b>Ojo:</b> es muy general (${Math.round(100 * aplica.length / hist.length)}% de todas las alertas).`)
  }
  if (r.nivel === 'ignorar' && aplica.some((x) => /caido|error|cshp/.test(x.clave))) L.push('⚠️ <b>Ojo:</b> ignorarías alertas de robots caídos o con error.')
  est.reglaPendiente = { ...r, texto, vence: new Date(Date.now() + 2 * 3600e3).toISOString() }
  L.push('', '¿La guardo?')
  return enviar(L.join('\n'), [[{ text: '✅ Sí, guárdala', callback_data: 'r+|0' }, { text: '✏️ No, la corrijo', callback_data: 'r-|0' }]])
}
export async function cargarReglas(ctx) { return ctx.q(ctx.KK, 'jefe_reglas?select=*&activa=eq.true&order=id').catch(() => []) }
async function listarReglas(ctx) {
  const rs = await cargarReglas(ctx)
  if (!rs.length) return enviar('📏 No me has enseñado reglas todavía.\n\nEjemplo:\n<i>cuando correos diga "Outlook" → causa: Outlook cerrado → hacer: abrir Outlook → nivel: atención</i>')
  const L = ['📏 <b>Tus reglas</b>', LINEA]
  rs.forEach((r, i) => L.push(`<b>${i + 1}.</b> ${describir(r)}\n    <i>aplicada ${r.aplicada || 0} vez/veces</i>`, ''))
  return enviar(L.join('\n'), rs.map((r, i) => [{ text: `🗑 Borrar la ${i + 1}`, callback_data: `rb|${r.id}` }]))
}

async function boton(cb, est, ctx) {
  if (String(cb.message?.chat?.id) !== CHAT) return
  const [acc, id] = String(cb.data || '').split('|')
  const responder = (txt) => api('answerCallbackQuery', { callback_query_id: cb.id, text: txt }).catch(() => {})
  const quitarBotones = () => api('editMessageReplyMarkup', { chat_id: CHAT, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {})
  if (acc === 'r+') {
    const r = est.reglaPendiente; est.reglaPendiente = null; await quitarBotones()
    if (!r || Date.now() > new Date(r.vence).getTime()) return responder('Ya no tengo esa regla, escríbela otra vez')
    await ctx.q(ctx.KK, 'jefe_reglas', { method: 'POST', prefer: 'return=minimal', body: {
      cuando: { robots: r.robots, centros: r.centros, textos: r.textos, desde: r.desde, hasta: r.hasta }, causa: r.causa, accion: r.accion, nivel: r.nivel, texto: r.texto } })
    ctx.log(`TELEGRAM regla nueva: ${r.texto}`)
    await responder('Guardada ✅')
    return enviar('✅ <b>Regla guardada.</b> La aplico desde mi siguiente ronda.\n<i>Escribe "reglas" para verlas o borrarlas.</i>')
  }
  if (acc === 'r-') { est.reglaPendiente = null; await quitarBotones(); await responder('OK'); return enviar('✏️ Va, escríbemela de nuevo con los cambios.') }
  if (acc === 'rb') {
    await ctx.q(ctx.KK, `jefe_reglas?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', prefer: 'return=minimal', body: { activa: false } })
    await responder('Borrada 🗑'); return enviar('🗑 Regla borrada.')
  }
  const hz = (await ctx.q(ctx.KK, `jefe_hallazgos?select=id,clave,titulo,patrones,causa&id=eq.${encodeURIComponent(id)}`).catch(() => []))[0]
  if (!hz) return responder('Esa alerta ya no existe')
  if (acc === 'v') { await quitarBotones(); return responder('Anotado 👀') }
  if (acc === 's') {
    est.silencio = { ...(est.silencio || {}), [hz.clave]: new Date(Date.now() + 24 * 3600e3).toISOString() }
    return responder('No te aviso de esto en 24 h 🔕')
  }
  if (acc === 'c+' || acc === 'c-') {
    for (const p of hz.patrones || []) await ctx.calificar(p, acc === 'c+')
    await quitarBotones()
    if (acc === 'c+') return responder('¡Bien! Le subo la confianza a esa causa ✅')
    est.espera = { patrones: hz.patrones || [], titulo: hz.titulo, hasta: new Date(Date.now() + 2 * 3600e3).toISOString() }
    await responder('Anotado ❌')
    return enviar(`🤔 Entonces, ¿qué pasó en:\n<b>${h(hz.titulo)}</b>?\n\nEscríbeme la causa real (y si quieres, qué se hizo, separado con <code>→</code>). La próxima vez lo digo así.`)
  }
}
async function enseñarCausa(texto, est, ctx) {
  const e = est.espera; est.espera = null
  const [causa, accion] = texto.split(/\s*(?:→|->)\s*/)
  for (const p of e.patrones) await ctx.enseñar(p, causa, accion || null)
  return enviar(`🧠 <b>Aprendido.</b>\nCuando vuelva a pasar <i>${h(e.titulo)}</i> voy a decir:\n<blockquote>🔎 ${h(causa)}${accion ? `\n🛠 ${h(accion)}` : ''}</blockquote>`)
}

function partesGT() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Guatemala', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date()).map((x) => [x.type, x.value]))
  return { fecha: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute, dia: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) }
}

// node --env-file=.env telegram.mjs --chat  → chats que le escribieron al bot (para TELEGRAM_CHAT_ID)
if (process.argv.includes('--chat')) {
  if (!TOKEN) { console.log('Falta TELEGRAM_TOKEN en .env'); process.exit(1) }
  const ups = await api('getUpdates', { timeout: 0 })
  const chats = [...new Map(ups.filter((u) => u.message).map((u) => [u.message.chat.id, u.message.chat])).values()]
  if (!chats.length) console.log('No hay mensajes. Escríbele "hola" al bot en Telegram y vuelve a correr esto.')
  chats.forEach((c) => console.log(`TELEGRAM_CHAT_ID=${c.id}    (${c.first_name || ''} ${c.last_name || ''} ${c.username ? '@' + c.username : ''})`))
}

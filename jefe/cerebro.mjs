/**
 * Cerebro del Jefe: IA LOCAL (Ollama, en esta PC). Nada sale a internet salvo la respuesta por Telegram.
 * Procesa la cola que deja el Jefe (cerebro\cola\*.json) cuando no entiende algo:
 *   · pregunta → responde con los datos reales de los robots, o si es una instrucción la convierte en REGLA
 *   · regla    → la convierte a regla estructurada; Joshua la confirma con ✅ antes de guardarla
 * Tarea "HPC Jefe Cerebro" (programar-cerebro.cmd), cada 2 min, oculta. Sin cola = termina al instante (no carga la IA).
 *   node --env-file=.env cerebro.mjs           procesa la cola
 *   node --env-file=.env cerebro.mjs --probar "pregunta"   prueba la IA sin Telegram
 * .env: OLLAMA_MODEL=qwen2.5:3b   OLLAMA_URL=http://127.0.0.1:11434 (opcional)
 */
import { readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
import { enviar, h, textoPropuestaRegla, telegramListo } from './telegram.mjs'

const E = process.env
const MODELO = (E.OLLAMA_MODEL || '').trim()
const OLLAMA = (E.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '')
const KK = { url: (E.KKZO_URL || '').replace(/\/$/, ''), key: E.KKZO_SERVICE_ROLE_KEY || '' }
const ROBOTS = ['digitadores', 'citas', 'guias', 'correos', 'garantias', 'truper', 'kardex', 'auditor-repuestos', 'despacho-repuestos', 'solicitud-repuestos']
const CENTROS = ['Nodus', 'Zona 4', 'Chimaltenango', 'Quiché', 'Escuintla', 'Río Hondo', 'Xela', 'Cobán', 'Huehuetenango', 'Mazatenango', 'Petén', 'Jutiapa', 'El Rancho', 'Morales']
const corto = (x, n = 300) => String(x?.message || x || '').split('\n')[0].slice(0, n)
const fechaGT = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' })
const horaGT = (d = new Date()) => new Date(d).toLocaleTimeString('es-GT', { timeZone: 'America/Guatemala', hour: '2-digit', minute: '2-digit', hour12: false })
function log(l) { console.log(l); try { mkdirSync('logs', { recursive: true }); appendFileSync(`logs/cerebro-${fechaGT()}.log`, `${horaGT()}  ${l}\r\n`) } catch {} }
async function q(db, path) {
  const r = await fetch(`${db.url}/rest/v1/${path}`, { headers: { apikey: db.key, Authorization: `Bearer ${db.key}` }, signal: AbortSignal.timeout(20000) })
  if (!r.ok) throw new Error(`Supabase ${path.split('?')[0]} HTTP ${r.status}`)
  return r.json()
}

/* ── Ollama ── */
async function pensar(sistema, usuario, json = false) {
  const t0 = Date.now()
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(240000),
    body: JSON.stringify({ model: MODELO, stream: false, keep_alive: '3m', ...(json ? { format: 'json' } : {}),
      options: { temperature: 0.2, num_ctx: 4096, num_predict: 500 },
      messages: [{ role: 'system', content: sistema }, { role: 'user', content: usuario }] }),
  })
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}: ${(await r.text()).slice(0, 150)}`)
  const j = await r.json()
  log(`   IA ${MODELO}: ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  return j.message?.content || ''
}

/* ── Contexto compacto (la IA local tiene poca memoria de trabajo: solo lo esencial) ── */
async function contexto() {
  const [st, carga, ab, mem, reglas] = await Promise.all([
    q(KK, 'robot_status?select=robot,centro,estado,detalle,last_seen').catch(() => []),
    q(KK, 'robot_carga?select=robot,pendientes,hoy').catch(() => []),
    q(KK, 'jefe_hallazgos?select=robot,severidad,titulo,causa&cerrado_en=is.null&order=severidad.asc&limit=12').catch(() => []),
    q(KK, 'jefe_aprendizaje?select=causa,causa_joshua,veces&order=veces.desc&limit=8').catch(() => []),
    q(KK, 'jefe_reglas?select=texto&activa=eq.true&limit=10').catch(() => []),
  ])
  const res = await q(KK, 'robot_resumen_hoy?select=robot,ok_hoy,errores_hoy').catch(() => [])
  // Hechos ya calculados: un modelo chico se equivoca sumando y comparando, así que se le da todo masticado
  const hoy = {}; for (const r of res) { if (r.robot === 'jefe') continue; const x = (hoy[r.robot] ||= [0, 0]); x[0] += r.ok_hoy || 0; x[1] += r.errores_hoy || 0 }
  const g = carga.find((c) => c.robot === 'garantias'); if (g?.hoy != null) hoy.garantias = [Math.max(hoy.garantias?.[0] || 0, g.hoy), hoy.garantias?.[1] || 0]
  const ranking = Object.entries(hoy).sort((a, b) => b[1][0] - a[1][0])
  const min = (d) => Math.round((Date.now() - new Date(d).getTime()) / 60000)
  const grupos = {}
  for (const s of st.filter((s) => s.robot !== 'jefe')) (grupos[s.robot] ||= []).push(s)
  const lineasRobot = Object.entries(grupos).map(([r, fs]) => {
    const vivos = fs.filter((f) => min(f.last_seen) <= 30), mudos = fs.filter((f) => min(f.last_seen) > 30)
    const trab = vivos.filter((f) => f.estado === 'trabajando').map((f) => f.centro || 'general'), err = vivos.filter((f) => f.estado === 'error').map((f) => f.centro || 'general')
    return `- ${r}: ${vivos.length} reportando${trab.length ? `, trabajando en ${trab.join('/')}` : ''}${err.length ? `, CON ERROR en ${err.join('/')}` : ''}${mudos.length ? `, sin reportar hace más de 30 min: ${mudos.map((f) => f.centro || 'general').join('/')}` : ''}`
  })
  return [
    `HORA: ${horaGT()} (${fechaGT()})`,
    'HECHO HOY (de más a menos, OK / errores):', ...ranking.map(([r, [o, e]], i) => `${i + 1}. ${r}: ${o} OK / ${e} errores`),
    ranking.length ? `EL QUE MÁS TRABAJÓ HOY: ${ranking[0][0]} con ${ranking[0][1][0]}` : 'NADIE HA TRABAJADO HOY TODAVÍA',
    'ROBOTS AHORA:', ...lineasRobot,
    'PENDIENTES: ' + (carga.filter((c) => c.pendientes > 0 && !c.robot.includes('@')).map((c) => `${c.robot} ${c.pendientes}`).join(', ') || 'ninguno'),
    'ALERTAS ABIERTAS:', ...(ab.length ? ab.map((a) => `- [${a.severidad === 'alta' ? 'CRÍTICA' : 'atención'}] ${a.robot}: ${corto(a.titulo, 80)}${a.causa ? ` (causa: ${corto(a.causa, 80)})` : ''}`) : ['- ninguna']),
    'LO APRENDIDO:', ...mem.map((m) => `- ${m.veces}x ${corto(m.causa_joshua || m.causa, 90)}`),
    'REGLAS DE JOSHUA:', ...(reglas.length ? reglas.map((r) => `- ${corto(r.texto, 120)}`) : ['- ninguna']),
  ].join('\n')
}

const SISTEMA = `Eres "el Jefe", supervisor de los robots de automatización de HPC Guatemala (centros de servicio).
Robots: digitadores (digita llamadas de garantía en CSHP, uno por centro), citas (crea llamadas desde citas), guias (imprime guías de envío),
correos (manda correos con Outlook), garantias (notas de crédito, se corre a mano), truper (catálogo mensual), kardex (inventario), repuestos (auditor/despacho/solicitud).
Centros: ${CENTROS.join(', ')}. "Zona 6" = Nodus.
Respondes a Joshua, tu jefe, en español de Guatemala, directo y corto (máximo 8 líneas).
USA SOLO los DATOS que te doy, copiando los números tal cual (ya vienen sumados y ordenados). Si algo no está en los datos, di que no lo sabes. Nunca inventes números, llamadas ni causas.
Lo preocupante es: alertas CRÍTICAS, robots CON ERROR, robots sin reportar que tienen pendientes. Un centro sin reportar SIN pendientes no es grave.`

const FORMATO_REGLA = `"regla": {"robots": [ids de esta lista o vacío: ${ROBOTS.join(', ')}], "centros": [de esta lista o vacío], "textos": [palabras exactas que debe contener la alerta], "desde": hora 0-23 o null, "hasta": hora 0-23 o null, "causa": texto o null, "accion": texto o null, "nivel": "alta" | "media" | "ignorar" | null, "explicacion": "cómo la entendiste, en una línea"}`

/* ── Normaliza lo que propone la IA (un modelo chico se puede equivocar: se filtra todo) ── */
function limpiarRegla(r = {}) {
  const lista = (x) => (Array.isArray(x) ? x : x ? [x] : []).map((v) => String(v).trim()).filter(Boolean)
  const robots = lista(r.robots).map((x) => x.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')).filter((x) => ROBOTS.includes(x))
  const centros = lista(r.centros).map((x) => CENTROS.find((c) => c.toLowerCase() === x.toLowerCase()) || (/zona ?6/i.test(x) ? 'Nodus' : null)).filter(Boolean)
  const hora = (x) => (Number.isInteger(+x) && x !== null && x !== '' && +x >= 0 && +x <= 23 ? +x : null)
  const nivel = ['alta', 'media', 'ignorar'].includes(String(r.nivel).toLowerCase()) ? String(r.nivel).toLowerCase() : null
  return { robots, centros, textos: lista(r.textos).slice(0, 3), desde: hora(r.desde), hasta: hora(r.hasta),
    causa: r.causa ? String(r.causa).slice(0, 200) : null, accion: r.accion ? String(r.accion).slice(0, 200) : null, nivel, explicacion: String(r.explicacion || '').slice(0, 200) }
}
const reglaValida = (r) => (r.robots.length || r.centros.length || r.textos.length || r.desde != null || r.hasta != null) && (r.causa || r.accion || r.nivel)

async function proponer(r, texto) {
  mkdirSync('cerebro/reglas', { recursive: true })
  const id = `${Date.now().toString(36)}`
  writeFileSync(`cerebro/reglas/${id}.json`, JSON.stringify({ ...r, texto }))
  const L = await textoPropuestaRegla(r, { q: (db, p) => q(KK, p), KK, corto }, '🧠📏 <b>Así entendí tu regla</b>')
  if (r.explicacion) L.splice(2, 0, `<i>${h(r.explicacion)}</i>`, '')
  L.push('', '¿La guardo?')
  await enviar(L.join('\n'), [[{ text: '✅ Sí, guárdala', callback_data: `ri+|${id}` }, { text: '✏️ No, la corrijo', callback_data: 'r-|0' }]])
}

async function procesar(item) {
  if (item.tipo === 'regla') {
    const sal = await pensar(SISTEMA, `Joshua te quiere enseñar una regla para tus alertas. Conviértela a JSON con este formato exacto:\n{${FORMATO_REGLA}}\n\nnivel: "alta" = avisar al momento (crítico), "media" = solo en el resumen, "ignorar" = no avisar.\nREGLA DE JOSHUA: ${item.texto}`, true)
    const r = limpiarRegla(JSON.parse(sal).regla || JSON.parse(sal))
    if (!reglaValida(r)) return enviar(`🧠 Lo pensé, pero no logré entender bien la regla:\n<i>${h(item.texto)}</i>\n\nDímela con: <b>cuándo</b> aplica (robot, centro o qué dice la alerta) y <b>qué hago</b> (causa, qué hacer o nivel).`)
    return proponer(r, item.texto)
  }
  // pregunta (o instrucción disfrazada de pregunta)
  const ctx = await contexto()
  const sal = await pensar(SISTEMA, `DATOS ACTUALES:\n${ctx}\n\nMENSAJE DE JOSHUA: "${item.texto}"\n\nSi es una pregunta, respóndela con los datos. Si es una instrucción para cambiar cómo avisas (avisar, no avisar, prioridad, causa de algo), es una REGLA.\nResponde en JSON: {"tipo": "respuesta" | "regla", "respuesta": "texto para Joshua (si tipo es respuesta)", ${FORMATO_REGLA}}`, true)
  const j = JSON.parse(sal)
  if (j.tipo === 'regla') {
    const r = limpiarRegla(j.regla)
    if (reglaValida(r)) return proponer(r, item.texto)
  }
  const resp = String(j.respuesta || '').trim()
  return enviar(resp ? `🧠 ${h(resp)}\n\n<i>— respuesta de mi IA local; si algo no cuadra, dime.</i>` : '🧠 Lo pensé, pero no tengo datos para contestarte eso.')
}

async function main() {
  if (process.argv.includes('--datos')) { console.log(await contexto()); return }   // ver exactamente lo que se le pasa a la IA
  if (process.argv.includes('--probar')) {
    if (!MODELO) { console.log('Falta OLLAMA_MODEL en .env'); return }
    const p = process.argv.slice(process.argv.indexOf('--probar') + 1).join(' ') || '¿cómo van los robots?'
    console.log(await pensar(SISTEMA, `DATOS ACTUALES:\n${await contexto()}\n\nPREGUNTA: ${p}`))
    return
  }
  if (!existsSync('cerebro/cola')) return
  const items = readdirSync('cerebro/cola').filter((f) => f.endsWith('.json')).sort()
  if (!items.length) return
  if (!MODELO || !telegramListo()) { log('Hay cola pero falta OLLAMA_MODEL o Telegram en .env'); return }
  for (const f of items.slice(0, 3)) {   // máx. 3 por vuelta (cada respuesta tarda)
    const ruta = `cerebro/cola/${f}`, item = JSON.parse(readFileSync(ruta, 'utf8'))
    log(`PIENSA ${item.tipo}: ${corto(item.texto, 120)}`)
    try {
      await procesar(item)
      unlinkSync(ruta)
    } catch (e) {
      log(`   ERROR ${corto(e, 200)}`)
      const viejo = Date.now() - new Date(item.creado).getTime() > 15 * 60000
      if (/ECONNREFUSED|fetch failed/i.test(String(e?.cause || e)) && !viejo) continue   // Ollama apagado: se reintenta
      await enviar(`😵 No pude pensar en:\n<i>${h(corto(item.texto, 150))}</i>\n<code>${h(corto(e?.cause?.code || e, 100))}</code>${/ECONNREFUSED|fetch failed/i.test(String(e?.cause || e)) ? '\n\nMi IA local (Ollama) parece apagada en la PC del Jefe.' : ''}`).catch(() => {})
      try { unlinkSync(ruta) } catch {}
    }
  }
}

setTimeout(() => { log('ERROR cerebro pasó de 9 min: se cerró'); process.exit(3) }, 9 * 60000).unref()
main().catch((e) => { log(`ERROR ${corto(e)}`); process.exitCode = 1 }).finally(() => process.exit(process.exitCode ?? 0))

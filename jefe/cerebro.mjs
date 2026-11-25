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
import { readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, appendFileSync, statSync } from 'node:fs'
import { enviar, h, textoPropuestaRegla, telegramListo } from './telegram.mjs'
import { buscarProductos, buscarNotas, buscarDocs, ficha, leerHistorial, guardarTurno, infoCatalogo } from './conocimiento.mjs'
import { abrirCSHP, leerLlamada, cerrarCSHP } from './cshp.mjs'   // SOLO LECTURA: nunca modifica, cambia status ni acepta nada

const E = process.env
const MODELO = (E.OLLAMA_MODEL || '').trim()
const OLLAMA = (E.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '')
const KK = { url: (E.KKZO_URL || '').replace(/\/$/, ''), key: E.KKZO_SERVICE_ROLE_KEY || '' }
const CC = { url: (E.CONSUMOS_URL || '').replace(/\/$/, ''), key: E.CONSUMOS_SERVICE_ROLE_KEY || '' }
const CSHP = { base: (E.CSHP_PROD_URL || E.CSHP_URL || '').replace(/\/(Login\.aspx)?$/i, ''), usuario: E.CSHP_PROD_USUARIO || E.CSHP_USUARIO, password: E.CSHP_PROD_PASSWORD || E.CSHP_PASSWORD }
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
async function pensar(sistema, usuario, json = false, { modelo = MODELO, historia = [], ctx = 4096, max = 500 } = {}) {
  const t0 = Date.now()
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(300000),
    body: JSON.stringify({ model: modelo, stream: false, keep_alive: '5m', ...(json ? { format: 'json' } : {}),
      options: { temperature: 0.2, num_ctx: ctx, num_predict: max },
      messages: [{ role: 'system', content: sistema }, ...historia, { role: 'user', content: usuario }] }),
  })
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}: ${(await r.text()).slice(0, 150)}`)
  const j = await r.json()
  log(`   IA ${modelo}: ${((Date.now() - t0) / 1000).toFixed(0)} s`)
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

/* ═══ Chat libre (PRUEBA): conversa con historial y responde de máquinas con el catálogo Truper + lo que Joshua le enseña ═══ */
const MODELO_CHAT = (E.OLLAMA_MODEL_CHAT || MODELO).trim()
const SISTEMA_CHAT = `Eres "el Jefe", asistente de HPC Guatemala (centros de servicio de herramientas TRUPER, PRETUL, FOSET, VOLTECK, etc.).
Conversas con Joshua (supervisor) en español de Guatemala, natural y directo. Sabes de dos cosas:
1) El CATÁLOGO TRUPER: te doy las FICHAS que el buscador encontró para cada pregunta (código entre corchetes, clave, especificaciones).
2) Los ROBOTS de automatización de HPC: te doy su DOCUMENTACIÓN (cómo funcionan) y sus DATOS de hoy.
REGLAS:
- Para máquinas usa SOLO las FICHAS y las NOTAS DE JOSHUA. Menciona siempre código y clave del producto ([código] CLAVE).
- Si la ficha no trae el dato (p. ej. peso), dilo claro; no lo inventes. El catálogo NO trae precios.
- Si comparas, haz una lista corta con la diferencia clave de cada uno.
- Las NOTAS DE JOSHUA son verdad y tienen prioridad sobre todo lo demás.
- Si las fichas no tienen nada que ver con la pregunta, di que no encontraste ese producto y pide más detalles (marca, potencia, uso).
- Máximo 12 líneas.`
const esSeguimiento = (t) => palabrasCortas(t) <= 6 || /\b(ese|esa|eso|esos|esas|el primero|el segundo|el tercero|el otro|cual de|y el|y la|tambien|comparalos|compara)\b/i.test(t.normalize('NFD').replace(/[̀-ͯ]/g, ''))
const palabrasCortas = (t) => String(t).trim().split(/\s+/).length
const sobreRobots = (t) => /robot|alerta|digitador|citas|guias|correo|garantias|jefe|pendiente|cshp|llamada|bandeja|caido|error/i.test(t.normalize('NFD').replace(/[̀-ͯ]/g, ''))

async function chatLibre(texto) {
  const hist = leerHistorial()
  // productos: lo que encuentra el buscador + (si es seguimiento) los de la plática anterior
  let productos = buscarProductos(texto, 5)
  const previos = hist.length && esSeguimiento(texto) ? hist[hist.length - 1].codigos.flatMap((c) => buscarProductos(c, 1)) : []
  productos = [...previos, ...productos.filter((p) => !previos.some((x) => x.codigo === p.codigo))].slice(0, 6)
  const notas = buscarNotas(texto, 3)
  const partes = []
  if (notas.length) partes.push('NOTAS DE JOSHUA (son verdad):\n' + notas.map((n) => `- ${n.texto}`).join('\n'))
  if (productos.length) partes.push('FICHAS DEL CATÁLOGO TRUPER:\n' + productos.map(ficha).join('\n'))
  const docs = buscarDocs(texto, sobreRobots(texto) ? 3 : 2)
  if (docs.length) partes.push('DOCUMENTACIÓN DE LOS ROBOTS:\n' + docs.map((d) => `[${d.nombre}]\n${d.texto}`).join('\n'))
  if (sobreRobots(texto)) partes.push('DATOS DE LOS ROBOTS:\n' + await contexto())
  const historia = hist.slice(-3).flatMap((t) => [{ role: 'user', content: t.pregunta }, { role: 'assistant', content: t.respuesta }])
  const resp = (await pensar(SISTEMA_CHAT, `${partes.join('\n\n')}\n\nPREGUNTA DE JOSHUA: ${texto}`, false, { modelo: MODELO_CHAT, historia, ctx: 6144, max: 600 })).trim()
  const usados = productos.filter((p) => resp.includes(p.codigo) || resp.toLowerCase().includes(p.clave.toLowerCase())).slice(0, 4)
  guardarTurno(texto, resp, (usados.length ? usados : productos.slice(0, 2)).map((p) => p.codigo))
  return { resp, usados, notas }
}

/* ═══ Investigar a pedido de Joshua: SOLO LECTURA (Supabase, logs de esta PC y CSHP por la web sin tocar nada) ═══ */
const ROBOT_ALIAS = { digitadores: /digitad/, citas: /\bcita/, guias: /\bgu[ií]a/, correos: /correo|outlook/, garantias: /garant|\bndc\b|nota de cr/, truper: /truper|cat[aá]logo/, kardex: /kardex|inventario/, 'auditor-repuestos': /auditor/, 'despacho-repuestos': /despacho/, 'solicitud-repuestos': /solicitud/, jefe: /\bjefe\b/ }
function colaLog(robot, n = 40) {
  const dir = `../${robot}/logs`
  if (!existsSync(dir)) return ''
  const f = readdirSync(dir).filter((x) => /^resumen-.*\.log$|^\d{4}-\d\d-\d\d\.log$/.test(x)).sort().pop()
  if (!f || Date.now() - statSync(`${dir}/${f}`).mtimeMs > 24 * 3600e3) return ''   // log viejo = el robot ya corre en otra PC
  return readFileSync(`${dir}/${f}`, 'utf8').split(/\r?\n/).filter(Boolean).slice(-n).join('\n')
}
async function investigar(texto) {
  const t = texto.toLowerCase(), partes = [], fuentes = new Set()
  const llamadas = [...new Set((texto.match(/\bLL[SM]\d*-\d+\b/gi) || []).map((x) => x.toUpperCase()))].slice(0, 2)
  if (llamadas.length) {
    let cshp = null
    for (const n of llamadas) {
      const [band, evs, hs] = await Promise.all([
        q(CC, `llamadas_actualizaciones?select=tecnico_nombre,created_at,digitado_en,pendiente_motivo,producto_sku,llamadas_centros(nombre),llamadas_estados(nombre)&num_llamada=eq.${encodeURIComponent(n)}&limit=1`).catch(() => []),
        q(KK, `robot_eventos?select=robot,tipo,mensaje,created_at&llamada=eq.${encodeURIComponent(n)}&order=id.desc&limit=10`).catch(() => []),
        q(KK, `jefe_hallazgos?select=titulo,causa,abierto_en,cerrado_en&or=(titulo.ilike.*${encodeURIComponent(n)}*,detalle.ilike.*${encodeURIComponent(n)}*)&order=id.desc&limit=3`).catch(() => []),
      ])
      let aud = {}; try { aud = JSON.parse(readFileSync('auditadas.json', 'utf8'))[n] || {} } catch {}
      let l = null
      try { cshp ||= await abrirCSHP(CSHP); l = await leerLlamada(cshp, n); fuentes.add('CSHP (solo lectura)') } catch (e) { partes.push(`CSHP ${n}: no se pudo leer (${corto(e, 100)})`) }
      partes.push([`LLAMADA ${n}`,
        band[0] ? `Bandeja: estado ${band[0].llamadas_estados?.nombre} · centro ${band[0].llamadas_centros?.nombre} · técnico ${band[0].tecnico_nombre} · SKU ${band[0].producto_sku} · ${band[0].digitado_en ? 'digitada ' + horaGT(band[0].digitado_en) : band[0].pendiente_motivo ? 'PENDIENTE: ' + corto(band[0].pendiente_motivo, 150) : 'sin digitar'}` : 'Bandeja: no está',
        l ? `CSHP: status actual "${l.statusActual}" · cliente "${corto(l.cliente, 50)}" · SKU ${l.sku} · guía recepción "${l.guiaRecep}" · comentario "${corto(l.comentario, 120)}"\nHistorial de status (más nuevo primero): ${l.statusLog.slice(0, 8).join(' → ')}${l.logistica ? `\nPaso a Logística: ${l.logistica}` : ''}` : '',
        evs.length ? 'Lo que hicieron los robots:\n' + evs.map((e) => `- ${horaGT(e.created_at)} ${e.robot} ${e.tipo}: ${corto(e.mensaje, 120)}`).join('\n') : 'Ningún robot la ha tocado',
        aud.estado ? `Auditoría Logística del Jefe: ${aud.estado} (${aud.razon})` : '',
        hs.length ? 'Alertas: ' + hs.map((x) => `${x.titulo}${x.causa ? ' — causa: ' + corto(x.causa, 100) : ''} (${x.cerrado_en ? 'resuelta' : 'abierta'})`).join(' | ') : ''].filter(Boolean).join('\n'))
      fuentes.add('Bandeja'); fuentes.add('eventos de robots')
    }
    await cerrarCSHP(cshp)
  }
  const robots = Object.entries(ROBOT_ALIAS).filter(([, re]) => re.test(t)).map(([r]) => r)
  for (const r of robots.slice(0, 2)) {
    const desde = new Date(Date.now() - 24 * 3600e3).toISOString()
    const [st, errs, hs, carga] = await Promise.all([
      q(KK, `robot_status?select=pc,centro,estado,detalle,ultimo_error,last_seen&robot=eq.${r}`).catch(() => []),
      q(KK, `robot_eventos?select=tipo,llamada,mensaje,created_at&robot=eq.${r}&tipo=eq.error&created_at=gte.${desde}&order=id.desc&limit=12`).catch(() => []),
      q(KK, `jefe_hallazgos?select=titulo,causa,accion,abierto_en,cerrado_en&robot=eq.${r}&order=id.desc&limit=5`).catch(() => []),
      q(KK, `robot_carga?select=robot,pendientes,detalle&robot=like.${r}*`).catch(() => []),
    ])
    const log = colaLog(r)
    partes.push([`ROBOT ${r}`,
      'Estado ahora: ' + (st.map((s) => `${s.centro || s.pc}: ${s.estado} (${corto(s.detalle, 60)}, hace ${Math.round((Date.now() - new Date(s.last_seen).getTime()) / 60000)} min)${s.ultimo_error ? ' último error: ' + corto(s.ultimo_error, 100) : ''}`).join(' | ') || 'sin reportes'),
      'Pendientes: ' + (carga.map((c) => `${c.robot} ${c.pendientes ?? '?'}`).join(', ') || '—'),
      errs.length ? 'Errores últimas 24 h:\n' + errs.map((e) => `- ${horaGT(e.created_at)} ${e.llamada || ''} ${corto(e.mensaje, 140)}`).join('\n') : 'Sin errores en 24 h',
      hs.length ? 'Alertas recientes:\n' + hs.map((x) => `- ${x.titulo} (${x.cerrado_en ? 'resuelta' : 'abierta'})${x.causa ? ' causa: ' + corto(x.causa, 100) : ''}`).join('\n') : '',
      log ? `Últimas líneas de su log en esta PC:\n${log.slice(-2500)}` : '(su log no está en esta PC)'].filter(Boolean).join('\n'))
    fuentes.add('estado y errores de robots'); if (log) fuentes.add('logs de esta PC')
  }
  const docs = buscarDocs(texto, 2)
  if (docs.length) partes.push('DOCUMENTACIÓN:\n' + docs.map((d) => `[${d.nombre}]\n${d.texto}`).join('\n'))
  if (!llamadas.length && !robots.length) return { resp: 'Dime qué investigo: un número de llamada (LLM21-…, LLS21-…) o un robot (digitadores, citas, guías, correos, garantías…).', fuentes: [] }
  const resp = (await pensar(SISTEMA_CHAT + '\nAhora estás INVESTIGANDO: explica qué pasó (en orden), la causa más probable y qué hacer. Si los datos no alcanzan para saberlo, dilo y di qué revisar.',
    `${partes.join('\n\n')}\n\nPEDIDO DE JOSHUA: ${texto}`, false, { modelo: MODELO_CHAT, ctx: 8192, max: 700 })).trim()
  guardarTurno(texto, resp, [])
  return { resp, fuentes: [...fuentes] }
}

async function procesar(item) {
  if (item.tipo === 'investiga') {
    const { resp, fuentes } = await investigar(item.texto)
    return enviar(`🔎 <b>Investigación</b>\n${h(resp)}${fuentes.length ? `\n\n<i>Fuentes: ${h(fuentes.join(' · '))}. No modifiqué nada.</i>` : ''}`)
  }
  if (item.tipo === 'chat') {
    const { resp, usados, notas } = await chatLibre(item.texto)
    const pie = [usados.length ? '📦 ' + usados.map((p) => `<a href="${h(p.pagina)}">[${h(p.codigo)}] ${h(p.clave)}</a>`).join(' · ') : '', notas.length ? `🧠 usé ${notas.length} nota(s) tuya(s)` : ''].filter(Boolean).join('\n')
    return enviar(`${h(resp)}${pie ? `\n\n<i>${pie}</i>` : ''}`)
  }
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
  if (process.argv.includes('--investiga')) {   // node --env-file=.env cerebro.mjs --investiga "qué pasó con LLM21-322408"
    const { resp, fuentes } = await investigar(process.argv.slice(process.argv.indexOf('--investiga') + 1).join(' '))
    console.log(`\n${resp}\n\nFuentes: ${fuentes.join(' · ')}`)
    return
  }
  if (process.argv.includes('--chat')) {   // conversar por consola (prueba): node --env-file=.env cerebro.mjs --chat "¿qué hidrolavadora me recomiendas?"
    const p = process.argv.slice(process.argv.indexOf('--chat') + 1).join(' ')
    const { resp, usados } = await chatLibre(p)
    console.log(`\n${resp}\n\n📦 ${usados.map((x) => `[${x.codigo}] ${x.clave}`).join(' · ') || '(sin fichas citadas)'}`)
    return
  }
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
  // un solo cerebro a la vez (lo despiertan escucha.mjs y su tarea de cada 2 min)
  const LOCK = 'cerebro/.pensando'
  try { if (Date.now() - statSync(LOCK).mtimeMs < 10 * 60000) return } catch {}
  writeFileSync(LOCK, String(process.pid))
  process.on('exit', () => { try { unlinkSync(LOCK) } catch {} })
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

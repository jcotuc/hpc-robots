/**
 * El Jefe investiga: para cada hallazgo junta evidencia, deduce la causa probable y qué hacer,
 * y lo va guardando como aprendizaje (jefe_aprendizaje): cuántas veces pasó, a qué hora suele pasar
 * y cuánto tarda en resolverse. Solo LEE (Supabase, logs locales, auditadas.json): no cambia nada.
 *
 * investigar(h, ctx) → { causa, evidencia: [..], accion, patrones: [{ patron, robot, causa, accion, ejemplo }] }
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { hostname } from 'node:os'

/* ── Reglas para clasificar un mensaje de error (la primera que coincide gana) ── */
const REGLAS = [
  { id: 'cshp_login', re: /iniciar sesi[oó]n|login|contrase[nñ]a|BloqSeguridad|usuario bloqueado/i,
    causa: 'CSHP no dejó iniciar sesión', accion: 'Revisar usuario y contraseña de CSHP en el .env y que la cuenta no esté bloqueada.' },
  { id: 'cshp_lento', re: /timeout|timed out|tard[oó]|no termin[oó] de abrir|exceeded/i,
    causa: 'CSHP tardó demasiado en responder', accion: 'Normalmente se recupera solo en la siguiente vuelta. Si se repite a la misma hora, CSHP está lento a esa hora.' },
  { id: 'red', re: /ENOTFOUND|EAI_AGAIN|ECONNRE|ETIMEDOUT|fetch failed|net::ERR|socket hang up|getaddrinfo/i,
    causa: 'La PC se quedó sin internet o sin red', accion: 'Revisar la conexión de la PC (WiFi/cable, VPN).' },
  { id: 'supabase', re: /supabase|PGRST|HTTP [45]\d\d|schema cache|violates|duplicate key/i,
    causa: 'Supabase rechazó o no respondió una consulta', accion: 'Ver el mensaje exacto: suele ser una columna/tabla que falta o un dato inválido.' },
  { id: 'pantalla', re: /locator|selector|not visible|waiting for|no se encontr[oó]|no apareci[oó]|aparece \d+ veces/i,
    causa: 'Un botón o campo de CSHP no apareció (la pantalla cargó a medias o cambió)', accion: 'Revisar la captura del robot. Si se repite con la misma llamada, revisarla a mano en CSHP.' },
  { id: 'navegador', re: /playwright|chromium|browser|target (page|closed)|has been closed/i,
    causa: 'El navegador del robot se cerró o no abrió', accion: 'Si se repite: cerrar procesos node/chrome colgados en la PC o reinstalar Chromium (npx.cmd playwright install chromium).' },
  { id: 'archivo', re: /EBUSY|EPERM|EACCES|\.lock|bloqueado por otro/i,
    causa: 'Un archivo del robot estaba bloqueado (otra corrida o el antivirus)', accion: 'Esperar la siguiente vuelta; si sigue, borrar el .lock viejo de la carpeta del robot.' },
  { id: 'cliente', re: /cliente/i, causa: 'Problema con el código de cliente', accion: 'Verificar que el cliente exista en CSHP/SAP con ese código.' },
  { id: 'sku', re: /\bsku\b|art[ií]culo|producto/i, causa: 'Problema con el SKU/producto', accion: 'Verificar que el SKU exista en CSHP y esté bien escrito.' },
  { id: 'duplicado', re: /duplic|ya existe|already/i, causa: 'El registro ya existía (duplicado)', accion: 'Revisar en CSHP que no haya dos llamadas para lo mismo.' },
]
export function clasificar(texto) {
  const t = String(texto || '')
  return REGLAS.find((r) => r.re.test(t)) || { id: 'otro', causa: 'Error no reconocido', accion: 'Revisar el mensaje y el log del robot.' }
}

/* ── Logs locales: el Jefe corre en la PC de Joshua; ahí también corren citas, correos y digitadores ── */
const CARPETA = { citas: 'citas', correos: 'correos', digitadores: 'digitadores', garantias: 'garantias', guias: 'guias' }
const ESTA_PC = hostname().trim().toUpperCase()
function ultimoLog(robot) {
  const dir = `../${CARPETA[robot] || robot}/logs`
  if (!existsSync(dir)) return null
  const archivos = readdirSync(dir).filter((f) => f.endsWith('.log')).map((f) => ({ f, t: statSync(`${dir}/${f}`).mtimeMs }))
  if (!archivos.length) return null
  const ult = archivos.sort((a, b) => b.t - a.t)[0]
  const lineas = readFileSync(`${dir}/${ult.f}`, 'utf8').split(/\r?\n/).filter((l) => l.trim())
  return { archivo: `${CARPETA[robot] || robot}\\logs\\${ult.f}`, modificado: new Date(ult.t), cola: lineas.slice(-25) }
}

/* ── Similitud de nombres (para técnicos) ── */
const normal = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/^(?:reparacion|diagnostico)\s*\+\s*/, '').replace(/[^a-z ñ]/g, ' ').replace(/\s+/g, ' ').trim()
function parecido(a, b) {
  const A = new Set(normal(a).split(' ').filter((x) => x.length > 2)), B = new Set(normal(b).split(' ').filter((x) => x.length > 2))
  if (!A.size || !B.size) return 0
  const comunes = [...A].filter((x) => B.has(x)).length
  return comunes / Math.min(A.size, B.size) * (comunes >= 2 ? 1 : 0.5)
}

/* ¿Es el mismo nombre con un error de dedo? ("andersn guzman" = "anderson guzman" = "andersson guzman") */
function distancia(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}
function mismoNombre(a, b) {
  const A = normal(a).split(' ').filter(Boolean), B = normal(b).split(' ').filter(Boolean)
  if (!A.length || A.length !== B.length) return normal(a) === normal(b)
  return A.every((w, i) => distancia(w, B[i]) <= (Math.max(w.length, B[i].length) >= 6 ? 2 : 1))
}
/* Clave estable para un técnico: si la memoria ya conoce un nombre casi igual, usa ese */
function claveTecnico(tipo, nombre, ctx) {
  const n = normal(nombre)
  for (const k of ctx.memoria?.keys() || []) {
    const [t, ...resto] = k.split(':')
    if (/^tecnico_/.test(t) && mismoNombre(resto.join(':'), n)) return `${tipo}:${resto.join(':')}`
  }
  return `${tipo}:${n}`
}

/* ================= Investigaciones por tipo de hallazgo ================= */

async function robotCaidoOError(h, ctx) {
  const [tipo, resto] = h.clave.split(':'), [robot, pc = ''] = resto.split('|')
  const ev = [], nombre = ctx.NOMBRES[robot] || robot
  const errs = await ctx.q(ctx.KK, `robot_eventos?select=mensaje,llamada,created_at&robot=eq.${robot}&pc=eq.${encodeURIComponent(pc)}&tipo=eq.error&order=id.desc&limit=3`).catch(() => [])
  errs.forEach((e) => ev.push(`Error ${ctx.horaGT(e.created_at)}${e.llamada ? ' ' + e.llamada : ''}: ${ctx.corto(e.mensaje, 160)}`))
  const local = pc.split(' · ')[0].trim().toUpperCase() === ESTA_PC ? ultimoLog(robot) : null
  if (local) ev.push(`Log ${local.archivo} (última línea ${ctx.horaGT(local.modificado)}): ${ctx.corto(local.cola.slice(-1)[0], 160)}`)

  if (ctx.cshpCaido) return { id: `${robot}:cshp_caido`, causa: 'CSHP no respondía en ese momento: el robot no es el problema', accion: 'Esperar a que CSHP vuelva; el robot sigue solo.', ev }
  if (tipo === 'caido') {
    if (local) {
      const minLog = (Date.now() - local.modificado.getTime()) / 60000
      if (minLog > 15) return { id: `${robot}:tarea_no_corre`, causa: `La tarea programada no está corriendo: el log no se mueve desde las ${ctx.horaGT(local.modificado)}`,
        accion: `Revisar en el Programador de tareas que "${nombre}" esté habilitada y no trabada (schtasks /Query). Si dice "En ejecución" hace mucho: schtasks /End y /Run.`, ev }
      const mon = local.cola.filter((l) => /\[monitor\]/.test(l)).pop()
      if (mon) return { id: `${robot}:monitor`, causa: 'El robot sí corre, pero el monitor rechaza sus reportes', accion: `Arreglar lo que dice el monitor: ${ctx.corto(mon, 160)}`, ev: [...ev, mon] }
      if (!local.cola.some((l) => /Fin|corrida|sin llamadas|Sin pendientes/i.test(l))) return { id: `${robot}:trabado`, causa: 'El robot arrancó pero no terminó (se quedó trabado)',
        accion: 'Cerrar el proceso node colgado; la siguiente corrida lo retoma.', ev }
      return { id: `${robot}:no_reporta`, causa: 'El robot corre (su log se mueve) pero no llega su reporte al dungeon', accion: 'Revisar internet de la PC o las claves MONITOR_* del .env.', ev }
    }
    return { id: `${robot}:pc_sin_senal`, causa: `La PC ${pc.split(' · ')[0]} no manda señal: apagada, dormida, sin internet o la tarea no corre`,
      accion: 'Revisar en esa PC: que esté encendida, con sesión iniciada, con internet y la tarea programada habilitada.', ev }
  }
  const r = clasificar([errs[0]?.mensaje, h.detalle].filter(Boolean).join(' '))
  return { id: `${robot}:${r.id}`, causa: r.causa, accion: r.accion, ev }
}

async function tecnicosPendientes(h, ctx) {
  const pend = await ctx.q(ctx.CC, `llamadas_actualizaciones?select=num_llamada,tecnico_nombre,pendiente_motivo,centro_id,llamadas_centros(nombre)&pendiente_por=eq.${encodeURIComponent(ctx.ROBOT_DIG)}&digitado_en=is.null&limit=100`)
  const sinTec = pend.filter((a) => /^T[eé]cnico no identificado/i.test(a.pendiente_motivo || ''))
  const otros = pend.filter((a) => !sinTec.includes(a) && !/^El SKU no coincide/i.test(a.pendiente_motivo || ''))
  const res = { ev: [], pats: [] }
  if (sinTec.length) {
    const cat = await ctx.q(ctx.CC, 'llamadas_tecnicos?select=nombre,tipo,centro_id&limit=2000')
    const centros = new Map((await ctx.q(ctx.CC, 'llamadas_centros?select=id,nombre').catch(() => [])).map((c) => [c.id, c.nombre]))
    cat.forEach((t) => { t.llamadas_centros = { nombre: centros.get(t.centro_id) } })
    const porNombre = new Map()
    sinTec.forEach((a) => {
      const k = [...porNombre.keys()].find((x) => mismoNombre(x, a.tecnico_nombre)) || normal(a.tecnico_nombre)
      porNombre.set(k, [...(porNombre.get(k) || []), a])
    })
    for (const [, ls] of porNombre) {
      const a = ls[0], centro = a.llamadas_centros?.nombre || `centro ${a.centro_id}`
      const mejores = cat.map((t) => ({ ...t, s: parecido(a.tecnico_nombre, t.nombre) })).filter((t) => t.s >= 0.5).sort((x, y) => y.s - x.s).slice(0, 2)
      const lista = ls.map((x) => x.num_llamada).join(', ')
      if (mejores.length) {
        const m = mejores[0], mc = m.llamadas_centros?.nombre || `centro ${m.centro_id}`
        res.ev.push(`"${a.tecnico_nombre}" (${centro}, ${lista}) → en el catálogo existe "${m.nombre}" (${mc}, ${m.tipo}). El robot no los empata porque el nombre no es igual.`)
        res.pats.push({ patron: claveTecnico('tecnico_nombre_distinto', a.tecnico_nombre, ctx), robot: 'digitadores',
          causa: `El técnico se registra en la Bandeja como "${a.tecnico_nombre}" y en el catálogo está como "${m.nombre}"`,
          accion: m.tipo !== 'reparacion' ? `Agregar "${m.nombre}" como técnico de reparación en el catálogo` : `Igualar el nombre: en el catálogo de técnicos o en el usuario del técnico en la Bandeja`, ejemplo: lista })
      } else {
        res.ev.push(`"${a.tecnico_nombre}" (${centro}, ${lista}) → no existe nada parecido en el catálogo de ningún centro.`)
        res.pats.push({ patron: claveTecnico('tecnico_no_existe', a.tecnico_nombre, ctx), robot: 'digitadores',
          causa: `"${a.tecnico_nombre}" no está en el catálogo de técnicos (técnico nuevo o de otro centro)`,
          accion: `Agregar "${a.tecnico_nombre}" al catálogo de técnicos de reparación de ${centro}. En cuanto esté, el robot retoma sus llamadas solo.`, ejemplo: lista })
      }
    }
  }
  for (const a of otros) {
    const r = clasificar(a.pendiente_motivo)
    res.ev.push(`${a.num_llamada}: ${ctx.corto(a.pendiente_motivo, 140)}`)
    res.pats.push({ patron: `digitadores_pendiente:${r.id}`, robot: 'digitadores', causa: r.causa, accion: r.accion, ejemplo: a.num_llamada })
  }
  const nuevos = res.pats.filter((p) => p.patron.startsWith('tecnico_no_existe')).length, distintos = res.pats.filter((p) => p.patron.startsWith('tecnico_nombre_distinto')).length
  return { causa: [nuevos && `${nuevos} técnico(s) que no están en el catálogo`, distintos && `${distintos} con el nombre escrito distinto al catálogo`, otros.length && `${otros.length} por otros motivos`].filter(Boolean).join(' · ') || 'Pendientes del robot',
    accion: res.pats.length === 1 ? res.pats[0].accion : 'Ver cada caso abajo: casi todos se resuelven en el catálogo de técnicos.', evidencia: res.ev, patrones: res.pats }
}

async function skuDistinto(h, ctx) {
  const num = h.clave.split(':')[1]
  const a = (await ctx.q(ctx.CC, `llamadas_actualizaciones?select=tecnico_nombre,producto_sku,created_at,llamadas_centros(nombre)&num_llamada=eq.${encodeURIComponent(num)}&limit=1`))?.[0]
  const tec = a?.tecnico_nombre || 'técnico desconocido', centro = a?.llamadas_centros?.nombre || '?'
  const tipo = /otra familia/i.test(h.titulo) ? 'otra_familia' : /facturada/i.test(h.titulo) ? 'ya_facturada' : /categor/i.test(h.titulo) ? 'sin_categoria' : /no es un c[oó]digo/i.test(h.titulo) ? 'sku_invalido' : 'otro'
  const causas = {
    otra_familia: [`El técnico registró un producto de otra familia que el que entró en recepción`, 'Confirmar con el técnico cuál es el producto real; si recepción se equivocó, corregir el SKU en CSHP.'],
    ya_facturada: ['El SKU no coincide y la llamada ya se facturó en CSHP', 'Decidir a mano si se corrige; el Jefe no toca llamadas facturadas.'],
    sin_categoria: ['Uno de los SKU no tiene familia en el catálogo de la Bandeja, así que el Jefe no puede comparar', 'Agregar el SKU a llamadas_producto_categorias.'],
    sku_invalido: ['El técnico escribió algo que no es un código de SKU en el formulario', 'Corregir el SKU en la Bandeja.'],
    otro: ['SKU distinto entre Bandeja y CSHP', 'Revisar a mano.'],
  }
  const [causa, accion] = causas[tipo]
  return { causa, accion, evidencia: [`${num} · ${tec} (${centro}) · subida ${a?.created_at ? ctx.horaGT(a.created_at) : '?'} · ${ctx.corto(h.detalle, 200)}`],
    patrones: [{ patron: `sku_${tipo}:tecnico:${normal(tec)}`, robot: 'digitadores', causa: `${tec} (${centro}): ${causa.toLowerCase()}`, accion, ejemplo: num }] }
}

function logisticaLlm(h, ctx) {
  const num = h.clave.split(':')[1]
  let a = {}; try { a = JSON.parse(readFileSync('auditadas.json', 'utf8'))[num] || {} } catch {}
  const fila = a.logistica || '', usuarios = ctx.USUARIOS_ROBOT.map(normal)
  const quien = (fila.match(/\b([A-Za-z][\w.]{2,})\b(?=[^·]*$)/) || [])[1] || ''
  const porRobot = usuarios.some((u) => u && normal(fila).includes(u))
  const persona = (fila.split(' · ').find((p) => /^[a-z][\w.]+$/i.test(p) && !/log[ií]stica|env[ií]o/i.test(p)) || quien || '').trim()
  if (!a.debe && a.paso && !porRobot) return {
    causa: `La pasó a Logística - Envío una persona${persona ? ` (usuario ${persona})` : ''}, no el robot`,
    accion: `Preguntar por qué se envió: si es un caso de envío real, hay que enseñarle la regla al robot (${a.campos || 'ver campos'}).`,
    evidencia: [`CSHP: ${fila || 'sin fila de logística'}`, a.campos || ''].filter(Boolean),
    patrones: [{ patron: `llm_movida_manual:${normal(persona) || 'desconocido'}`, robot: 'digitadores', causa: `${persona || 'Alguien'} pasa a mano a Logística llamadas que el robot dejó en Facturación`, accion: 'Confirmar si falta una regla de envío en el robot.', ejemplo: num }] }
  if (a.debe && !a.paso) return {
    causa: `Debía ir a Logística (${a.razon}) y se quedó en "${a.status}"`, accion: 'Pasarla a Logística - Envío en CSHP y revisar por qué el robot no lo hizo (ver log de Digitadores).',
    evidencia: [a.campos || ''], patrones: [{ patron: 'llm_no_paso_logistica', robot: 'digitadores', causa: 'El robot no pasó a Logística una llamada que debía', accion: 'Revisar la regla de envío del robot.', ejemplo: num }] }
  return { causa: `Señal de envío incompleta: ${a.razon || '?'}`, accion: 'Revisar los campos en CSHP (guía de recepción, cliente, OPE-).', evidencia: [a.campos || ''],
    patrones: [{ patron: `llm_dudosa:${normal(a.razon)}`, robot: 'digitadores', causa: `Llamadas con señal incompleta (${a.razon})`, accion: 'Corregir los datos de recepción.', ejemplo: num }] }
}

async function citasConError(h, ctx) {
  const filas = await ctx.q(ctx.KK, `cita_equipos?select=orden,sync_error,citas!inner(numero)&sync_error=not.is.null&order=last_sync_attempt_at.desc&limit=50`).catch(() => [])
  return agrupar(filas.map((f) => ({ ref: `${f.citas.numero}-${f.orden}`, txt: f.sync_error })), 'citas', ctx)
}
async function correosConError(h, ctx) {
  const filas = await ctx.q(ctx.CC, 'correos_cola?select=tipo,referencia,ultimo_error&estado=eq.error&order=created_at.desc&limit=50').catch(() => [])
  return agrupar(filas.map((f) => ({ ref: `${f.tipo} ${f.referencia || ''}`.trim(), txt: f.ultimo_error })), 'correos', ctx)
}
async function garantiasConError(h, ctx) {
  const filas = (await ctx.q(ctx.KK, `garantias_manuales?select=codigo_cliente,sync_status,external_id&deleted=eq.false&last_sync_attempt_at=gte.${ctx.haceMin(7 * 24 * 60)}&limit=500`).catch(() => []))
    .filter((g) => ['rejected', 'needs_review', 'duplicated'].includes(g.sync_status))
  const txt = { rejected: 'falló 3 veces al crear la llamada', needs_review: 'se creó en CSHP pero no se guardó en Supabase', duplicated: 'duplicada en CSHP' }
  return agrupar(filas.map((g) => ({ ref: `Cliente ${g.codigo_cliente}`, txt: txt[g.sync_status], id: g.sync_status })), 'garantias', ctx)
}
/* Agrupa errores por causa (para ver cuál se repite) */
function agrupar(items, robot, ctx) {
  const grupos = new Map()
  for (const it of items) {
    const r = it.id ? { id: it.id, causa: it.txt, accion: 'Revisar el registro en la app y en CSHP.' } : clasificar(it.txt)
    const g = grupos.get(r.id) || { ...r, refs: [], muestra: it.txt }; g.refs.push(it.ref); grupos.set(r.id, g)
  }
  const orden = [...grupos.values()].sort((a, b) => b.refs.length - a.refs.length)
  if (!orden.length) return { causa: 'Ya no hay errores para investigar', accion: '', evidencia: [], patrones: [] }
  return {
    causa: orden.map((g) => `${g.refs.length} × ${g.causa}`).join(' · '), accion: orden[0].accion,
    evidencia: orden.map((g) => `${g.causa}: ${g.refs.slice(0, 5).join(', ')}${g.refs.length > 5 ? '…' : ''} — ej. "${ctx.corto(g.muestra, 120)}"`),
    patrones: orden.map((g) => ({ patron: `${robot}:${g.id}`, robot, causa: g.causa, accion: g.accion, ejemplo: g.refs.slice(0, 3).join(', ') })),
  }
}

async function citasAtoradas(h, ctx) {
  const st = (await ctx.q(ctx.KK, 'robot_status?select=pc,estado,last_seen,detalle&robot=eq.citas').catch(() => []))[0]
  const min = st ? (Date.now() - new Date(st.last_seen).getTime()) / 60000 : null
  const [id, causa, accion] = !st ? ['sin_robot', 'El robot de Citas nunca ha reportado', 'Revisar que la tarea de Citas exista en la PC.']
    : min > 15 ? ['robot_no_corre', `El robot de Citas no corre desde las ${ctx.horaGT(st.last_seen)}`, 'Revisar la tarea programada de Citas.']
    : ['las_salta', `El robot sí corre (${st.estado}: ${ctx.corto(st.detalle, 80)}) pero no toma esas citas`, 'Revisar que las citas tengan sync_status "listo" y datos completos (cliente, SKU).']
  return { causa, accion, evidencia: [ctx.corto(h.detalle, 200)], patrones: [{ patron: `citas:atoradas:${id}`, robot: 'citas', causa, accion, ejemplo: '' }] }
}

/* ================= Punto de entrada ================= */
export async function investigar(h, ctx) {
  const c = h.clave
  try {
    if (/^(caido|error):/.test(c)) {
      const r = await robotCaidoOError(h, ctx)
      return { causa: r.causa, accion: r.accion, evidencia: r.ev, patrones: [{ patron: r.id, robot: c.split(':')[1].split('|')[0], causa: r.causa, accion: r.accion, ejemplo: c.split('|')[1] || '' }] }
    }
    if (c === 'digitadores:pendientes') return await tecnicosPendientes(h, ctx)
    if (c.startsWith('sku:')) return await skuDistinto(h, ctx)
    if (c.startsWith('llm:')) return logisticaLlm(h, ctx)
    if (c === 'citas:error') return await citasConError(h, ctx)
    if (c === 'citas:atoradas') return await citasAtoradas(h, ctx)
    if (c === 'correos:error') return await correosConError(h, ctx)
    if (c === 'garantias:error') return await garantiasConError(h, ctx)
    if (c === 'robots:varios') return { causa: /CSHP/.test(h.titulo) ? 'CSHP está caído o muy lento' : 'Varios robots fallan a la vez pero CSHP responde: red o PCs',
      accion: /CSHP/.test(h.titulo) ? 'Esperar o avisar a sistemas.' : 'Revisar internet de las PCs.', evidencia: [ctx.corto(h.detalle, 200)],
      patrones: [{ patron: /CSHP/.test(h.titulo) ? 'cshp_caido' : 'varios_robots_red', robot: 'jefe', causa: h.titulo, accion: '', ejemplo: '' }] }
    if (c === 'cshp:caido') { const r = clasificar(h.detalle); return { causa: `CSHP: ${r.causa}`, accion: r.accion, evidencia: [ctx.corto(h.detalle, 200)], patrones: [{ patron: `cshp:${r.id}`, robot: 'jefe', causa: `CSHP: ${r.causa}`, accion: r.accion, ejemplo: '' }] } }
  } catch (e) {
    return { causa: null, accion: null, evidencia: [`No se pudo investigar: ${ctx.corto(e, 160)}`], patrones: [] }
  }
  return null   // sin investigación para este tipo
}

/* ================= Memoria: lo aprendido ================= */
/** Junta lo que ya sabe de esos patrones: "pasó N veces, suele ser a las H h, se resuelve en ~M min" */
export function recordar(patrones, memoria, ctx) {
  const notas = []
  for (const p of patrones) {
    const m = memoria.get(p.patron); if (!m || !m.veces) continue
    const horas = Object.entries(m.horas || {}).sort((a, b) => b[1] - a[1])
    const hora = horas[0] && horas[0][1] >= 2 ? ` · suele pasar a las ${horas[0][0]} h` : ''
    const res = m.resueltos ? ` · se resuelve en ~${Math.round(m.minutos_resolver / m.resueltos)} min` : ''
    notas.push(`${m.veces >= 3 ? 'RECURRENTE: ' : ''}ya pasó ${m.veces} vez/veces (desde ${new Date(m.primera).toLocaleDateString('es-GT', { timeZone: 'America/Guatemala' })})${hora}${res} — ${m.causa}`)
  }
  return notas
}

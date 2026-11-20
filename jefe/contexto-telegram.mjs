/**
 * Lo que necesita telegram.mjs para contestar (consultas a Supabase, aprender de Joshua, resumen de Logística).
 * Lo usan revisar.mjs (alertas y resumen) y escucha.mjs (conversación al instante).
 */
import { mkdirSync, appendFileSync, readFileSync } from 'node:fs'

const E = process.env
export const KK = { nombre: 'kkzo', url: (E.KKZO_URL || '').replace(/\/$/, ''), key: E.KKZO_SERVICE_ROLE_KEY || '' }
export const CC = { nombre: 'ConsumosCS', url: (E.CONSUMOS_URL || '').replace(/\/$/, ''), key: E.CONSUMOS_SERVICE_ROLE_KEY || '' }
export const NOMBRES = { citas: 'Citas', guias: 'Guías', digitadores: 'Digitadores', correos: 'Correos', garantias: 'Garantías', truper: 'Catálogo Truper',
  'solicitud-repuestos': 'Solicitud de repuestos', 'despacho-repuestos': 'Despacho de repuestos', 'auditor-repuestos': 'Auditor de repuestos', kardex: 'Kardex (inventario)' }
export const corto = (x, n = 300) => String(x?.message || x || '').split('\n')[0].slice(0, n)
export const fechaGT = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' })
const horaGT = (d = new Date()) => new Date(d).toLocaleTimeString('es-GT', { timeZone: 'America/Guatemala', hour: '2-digit', minute: '2-digit', hour12: false })
export function log(l) {
  console.log(l)
  try { mkdirSync('logs', { recursive: true }); appendFileSync(`logs/resumen-${fechaGT()}.log`, `${horaGT()}  ${l}\r\n`) } catch {}
}
export const leerAud = () => { try { return JSON.parse(readFileSync('auditadas.json', 'utf8')) } catch { return {} } }

/* PostgREST mínimo (sin dependencias) */
export async function q(db, path, { method = 'GET', body, prefer } = {}) {
  if (!db.url || !db.key) throw new Error(`Faltan URL/KEY de ${db.nombre} en .env`)
  const r = await fetch(`${db.url}/rest/v1/${path}`, {
    method, signal: AbortSignal.timeout(20000),
    headers: { apikey: db.key, Authorization: `Bearer ${db.key}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const t = await r.text()
  if (!r.ok) throw new Error(`${db.nombre} ${path.split('?')[0]} HTTP ${r.status}: ${t.slice(0, 200)}`)
  return t ? JSON.parse(t) : null
}

/* Resumen de Logística - Envío del día (va en el resumen de Telegram) */
export function resumenLogistica() {
  const hoy = fechaGT(), del = Object.entries(leerAud()).filter(([, a]) => a.estado === 'alerta' && a.revisada && new Date(a.revisada).toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' }) === hoy)
  if (!del.length) return ''
  const persona = del.filter(([, a]) => !a.debe && a.paso && !a.robot), robot = del.filter(([, a]) => !a.debe && a.paso && a.robot), falto = del.filter(([, a]) => a.debe && !a.paso)
  const quien = {}
  for (const [, a] of persona) { const u = (String(a.logistica || '').split(' · ').pop() || '?').trim(); quien[u] = (quien[u] || 0) + 1 }
  const L = ['<b>Logística - Envío (auditoría LLM)</b>']
  if (persona.length) L.push(`• ${persona.length} pasadas a mano sin ser envío/Cemaco: ${Object.entries(quien).sort((a, b) => b[1] - a[1]).map(([u, n]) => `${u} (${n})`).join(', ')}`)
  if (robot.length) L.push(`• 🚨 ${robot.length} pasadas por el ROBOT sin regla`)
  if (falto.length) L.push(`• ${falto.length} debían ir a Logística y no fueron: ${falto.slice(0, 5).map(([n]) => n).join(', ')}`)
  return L.join('\n')
}

/* Contexto que usa telegram.mjs (preguntas, botones, aprender de Joshua) */
export function contextoTelegram() {
  return { q, KK, CC, NOMBRES, corto, log, resumenLogistica, leerAud,
      calificar: async (patron, bien) => {
        const m = (await q(KK, `jefe_aprendizaje?select=confirmadas,rechazadas&patron=eq.${encodeURIComponent(patron)}`))[0]; if (!m) return
        await q(KK, `jefe_aprendizaje?patron=eq.${encodeURIComponent(patron)}`, { method: 'PATCH', prefer: 'return=minimal',
          body: bien ? { confirmadas: (m.confirmadas || 0) + 1 } : { rechazadas: (m.rechazadas || 0) + 1 } })
        log(`TELEGRAM ${bien ? 'confirmó' : 'rechazó'} la causa de ${patron}`)
      },
      enseñar: async (patron, causa, accion) => {
        await q(KK, `jefe_aprendizaje?patron=eq.${encodeURIComponent(patron)}`, { method: 'PATCH', prefer: 'return=minimal', body: { causa_joshua: causa, ...(accion ? { accion_joshua: accion } : {}) } })
        log(`TELEGRAM aprendió de Joshua para ${patron}: ${causa}`)
      } }
}

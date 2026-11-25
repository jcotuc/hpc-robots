/**
 * ¿Digitadores está al día? — SOLO LECTURA (Bandeja de ConsumosCS + log de hoy). No toca CSHP ni nada.
 *   npm.cmd run estado
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync, existsSync } from 'node:fs'

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const ROBOT = (process.env.ROBOT_NOMBRE || 'robot-digitadores').trim().toLowerCase()
const ESTADO = (process.env.ESTADO_BANDEJA || 'Garantía').trim()
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
const hace = (d) => { const m = Math.round((Date.now() - new Date(d).getTime()) / 60000); return m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d` }
const fechaGT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' })
const sal = (e, d) => { if (e) { console.error(`❌ Supabase (${d}): ${e.message}`); process.exit(1) } }

const { data: cfg, error: e1 } = await sb.from('etiquetera_config').select('valor').eq('clave', 'robot_garantia_activo').maybeSingle(); sal(e1, 'etiquetera_config')
const { data: est, error: e2 } = await sb.from('llamadas_estados').select('id, nombre'); sal(e2, 'llamadas_estados')
const gar = est.find((x) => norm(x.nombre) === norm(ESTADO))
if (!gar) { console.error(`❌ No existe el estado "${ESTADO}"`); process.exit(1) }
const { data: filas, error: e3 } = await sb.from('llamadas_actualizaciones')
  .select('num_llamada, created_at, tecnico_nombre, tomado_por, tomado_en, pendiente_en, pendiente_por, pendiente_motivo, llamadas_centros(nombre)')
  .eq('estado_id', gar.id).is('digitado_en', null).is('garantia_id', null).order('created_at').limit(500); sal(e3, 'llamadas_actualizaciones')

const centro = (a) => (a.llamadas_centros?.nombre || '?').replace(/^Zona 6$/, 'Nodus (Zona 6)')
const porDigitar = filas.filter((a) => !a.pendiente_en)
const delRobot = filas.filter((a) => a.pendiente_en && (a.pendiente_por || '').toLowerCase() === ROBOT)
const deGente = filas.filter((a) => a.pendiente_en && (a.pendiente_por || '').toLowerCase() !== ROBOT)

// digitadas hoy (log del robot en esta PC)
let hoy = 0, errHoy = 0
const log = `logs/resumen-${fechaGT}.log`
if (existsSync(log)) for (const l of readFileSync(log, 'utf8').split(/\r?\n/)) { if (/\sDIGITADA\s/.test(l) && !/YA DIGITADA/.test(l)) hoy++; if (/\sERROR\s/.test(l)) errHoy++ }

console.log(`\n=== Digitadores · ${new Date().toLocaleString('es-GT', { timeZone: 'America/Guatemala' })} ===`)
console.log(`Robot en Administración: ${cfg?.valor === true ? 'ENCENDIDO' : 'APAGADO (no digita nada)'}`)
console.log(`Hoy en esta PC: ${hoy} digitadas · ${errHoy} errores`)
const vieja = porDigitar[0]
console.log(porDigitar.length + delRobot.length === 0
  ? '\n✅ AL DÍA: no hay llamadas de Garantía esperando al robot.'
  : `\n⏳ ${porDigitar.length} por digitar${vieja ? ` (la más vieja hace ${hace(vieja.created_at)})` : ''} · ${delRobot.length} pendientes del robot (necesitan a alguien)`)

const tabla = {}
for (const [lista, col] of [[porDigitar, 'Por digitar'], [delRobot, 'Pendiente robot'], [deGente, 'Pendiente digitador']])
  for (const a of lista) { const c = centro(a); (tabla[c] ||= { 'Por digitar': 0, 'Pendiente robot': 0, 'Pendiente digitador': 0 })[col]++ }
if (Object.keys(tabla).length) { console.log('\nPor centro:'); console.table(tabla) }

if (porDigitar.length) {
  console.log('Por digitar (el robot las toma en la siguiente vuelta):')
  for (const a of porDigitar.slice(0, 20)) console.log(`  ${a.num_llamada.padEnd(14)} ${centro(a).padEnd(16)} hace ${hace(a.created_at).padEnd(6)} ${a.tomado_por ? `tomada por ${a.tomado_por}` : ''}`)
}
if (delRobot.length) {
  console.log('\nPendientes del robot (motivo):')
  const motivos = {}
  for (const a of delRobot) { const m = String(a.pendiente_motivo || 'sin motivo').split(/[·:]/)[0].trim(); (motivos[m] ||= []).push(a.num_llamada) }
  for (const [m, ls] of Object.entries(motivos)) console.log(`  ${ls.length} × ${m}: ${ls.slice(0, 8).join(', ')}${ls.length > 8 ? '…' : ''}`)
  // técnicos que hay que agregar o corregir en el catálogo (con eso el robot las retoma solo)
  const tecs = {}
  for (const a of delRobot.filter((x) => /^T[eé]cnico no identificado/i.test(x.pendiente_motivo || ''))) {
    const k = `${(a.tecnico_nombre || '?').trim()} (${centro(a)})`; (tecs[k] ||= []).push(a.num_llamada)
  }
  if (Object.keys(tecs).length) {
    console.log('\nTécnicos que no están en el catálogo (agregarlos y el robot las retoma solo):')
    for (const [t, ls] of Object.entries(tecs)) console.log(`  ${t.padEnd(45)} ${ls.join(', ')}`)
  }
}
if (deGente.length) console.log(`\n${deGente.length} pendiente(s) que dejó un digitador (no son del robot).`)
console.log('')

/**
 * Resumen claro de lo que hizo el robot.
 *   npm.cmd run log                → hoy
 *   npm.cmd run log -- 2026-10-22  → otro día
 *   npm.cmd run log -- LLS21-550699 → historial de una llamada
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'

const arg = (process.argv[2] || '').trim()
const fecha = /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' })
const llamada = /^LL/i.test(arg) ? arg.toUpperCase() : ''
const hora = (iso) => new Date(iso).toLocaleTimeString('es-GT', { timeZone: 'America/Guatemala', hour12: false })
const dia = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' })

let registro = {}
try { registro = JSON.parse(readFileSync('registro.json', 'utf8')) } catch { /* vacío */ }

if (llamada) {
  const r = registro[llamada]
  if (!r) { console.log(`\n${llamada} no aparece en registro.json\n`); process.exit(0) }
  console.log(`\n${llamada} · ${r.ambiente} · estado: ${r.estado || 'incompleta'}\n`)
  for (const p of r.pasos) {
    console.log(`  ${dia(p.hora)} ${hora(p.hora)}  ${p.paso.padEnd(12)} ${[p.impresora, p.nuevo, p.error].filter(Boolean).join(' · ')}`)
    if (p.visor) console.log(`  ${' '.repeat(33)}visor: ${p.visor}`)
  }
  console.log()
  process.exit(0)
}

const filas = Object.entries(registro).filter(([, r]) => dia(r.inicio) === fecha)
const si = (r, paso) => (r.pasos.some((p) => p.paso === paso) ? 'sí' : '--')
console.log(`\nRobot de guías · ${fecha} · ${filas.length} llamada(s)\n`)
if (filas.length) {
  console.log('  HORA      LLAMADA         STATUS  GUÍA  DIAG  RESULTADO')
  for (const [n, r] of filas.sort((a, b) => a[1].inicio.localeCompare(b[1].inicio))) {
    const err = [...r.pasos].reverse().find((p) => p.error)?.error?.split('\n')[0] || ''
    const res = r.estado === 'completa' ? 'OK' : r.estado === 'error' ? `ERROR: ${err}` : 'INCOMPLETA'
    console.log(`  ${hora(r.inicio)}  ${n.padEnd(14)}  ${si(r, 'status').padEnd(6)}  ${si(r, 'guia').padEnd(4)}  ${si(r, 'diagnostico').padEnd(4)}  ${res}`)
  }
  const mal = filas.filter(([, r]) => r.estado !== 'completa' && r.pasos.some((p) => p.paso === 'status'))
  if (mal.length) console.log(`\n  REVISAR A MANO: ${mal.map(([n]) => n).join(', ')}  (detalle: npm.cmd run log -- ${mal[0][0]})`)
}

const res = `logs/resumen-${fecha}.log`
const det = existsSync(`logs/detalle-${fecha}.log`) ? `logs/detalle-${fecha}.log` : `logs/${fecha}.log` // nombre anterior
if (existsSync(res)) {
  const lineas = readFileSync(res, 'utf8').trim().split(/\r?\n/)
  console.log(`\nÚltimos eventos (${res}):`)
  lineas.slice(-15).forEach((l) => console.log(`  ${l}`))
}
if (existsSync(det)) {
  const txt = readFileSync(det, 'utf8')
  const corridas = (txt.match(/^=====/gm) || []).length
  const ultima = txt.slice(txt.lastIndexOf('=====')).trim().split(/\r?\n/).slice(0, 25)
  console.log(`\nCorridas automáticas hoy: ${corridas}. Última (${det}):`)
  ultima.forEach((l) => console.log(`  ${l}`))
} else {
  const hay = existsSync('logs') ? readdirSync('logs').join(', ') : '(no existe la carpeta logs)'
  console.log(`\nNo hay log de la tarea programada para ${fecha}. En logs: ${hay}`)
}
console.log()

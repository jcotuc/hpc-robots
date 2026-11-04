/**
 * Resumen claro de lo que hizo el robot de citas.
 *   npm.cmd run log                → hoy
 *   npm.cmd run log -- 2026-10-29  → otro día
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'

const arg = (process.argv[2] || '').trim()
const fecha = /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' })
const res = `logs/resumen-${fecha}.log`

if (!existsSync(res)) {
  const hay = existsSync('logs') ? readdirSync('logs').join(', ') : '(no existe la carpeta logs)'
  console.log(`\nNo hay resumen para ${fecha}. En logs: ${hay}`)
  console.log('Si la tarea programada estuviera corriendo, habría una línea "--- corrida" cada 5 minutos.\n')
  process.exit(0)
}

const lineas = readFileSync(res, 'utf8').trim().split(/\r?\n/).filter(Boolean)
const corridas = lineas.filter((l) => l.includes('--- corrida'))
const ok = lineas.filter((l) => /^\S+\s+OK /.test(l))
const revisar = lineas.filter((l) => /^\S+\s+REVISAR /.test(l))
const error = lineas.filter((l) => /^\S+\s+ERROR /.test(l))
const ultima = corridas.at(-1)?.split(/\s+/)[0]

console.log(`\nRobot de citas · ${fecha}`)
console.log(`  Corridas: ${corridas.length}${ultima ? ` · última a las ${ultima}` : ''}`)
console.log(`  Llamadas creadas: ${ok.length} · A revisar: ${revisar.length} · Con error: ${error.length}\n`)

if (ok.length) { console.log('LLAMADAS CREADAS'); ok.forEach((l) => console.log(`  ${l}`)); console.log() }
if (revisar.length) { console.log('A REVISAR EN LA APP'); revisar.forEach((l) => console.log(`  ${l}`)); console.log() }
if (error.length) { console.log('ERRORES (se reintentan solos hasta 3 veces)'); error.forEach((l) => console.log(`  ${l}`)); console.log() }

console.log('ÚLTIMAS 15 CORRIDAS')
corridas.slice(-15).forEach((l) => console.log(`  ${l}`))
console.log()

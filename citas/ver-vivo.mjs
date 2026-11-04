/**
 * Pantalla en vivo del robot de citas: deja esta ventana de PowerShell abierta y cada corrida
 * de la tarea programada (cada 5 min) aparece aquí sola.
 *   npm.cmd run sync:vivo        (desde C:\hpc-citas)
 * Ctrl+C para cerrar. Cerrar esta ventana NO detiene el robot.
 */
import { readFileSync, existsSync } from 'node:fs'

const fechaGT = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' })
const horaGT = () => new Date().toLocaleTimeString('es-GT', { timeZone: 'America/Guatemala', hour12: false })
const C = { verde: '\x1b[32m', amarillo: '\x1b[33m', rojo: '\x1b[31m', gris: '\x1b[90m', negrita: '\x1b[1m', fin: '\x1b[0m' }

function pintar(l) {
  if (/\sOK\s/.test(l)) return `${C.verde}+ ${l}${C.fin}`
  if (/\sREVISAR\s/.test(l)) return `${C.amarillo}! ${l}${C.fin}`
  if (/\sERROR\s|FALLÓ/.test(l)) return `${C.rojo}x ${l}${C.fin}`
  if (/sin equipos pendientes|OMITIDA|tomados por otra/.test(l)) return `${C.gris}  ${l}${C.fin}`
  if (/--- corrida/.test(l)) return `${C.negrita}= ${l}${C.fin}`
  return `   ${l}`
}

let fecha = fechaGT()
let lineasLeidas = 0
let ultimaCorrida = null

const lineasDe = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean) : [])

function leerNuevas() {
  const hoy = fechaGT()
  if (hoy !== fecha) { fecha = hoy; lineasLeidas = 0; console.log(`\n${C.negrita}──── ${fecha} ────${C.fin}`) }
  const lineas = lineasDe(`logs/resumen-${fecha}.log`)
  if (lineas.length < lineasLeidas) lineasLeidas = 0
  for (const l of lineas.slice(lineasLeidas)) {
    console.log(pintar(l))
    if (l.includes('--- corrida')) ultimaCorrida = Date.now()
  }
  lineasLeidas = lineas.length
}

// Al abrir: mostrar las últimas 10 líneas de hoy
console.clear()
console.log(`${C.negrita}Robot de citas · en vivo${C.fin}  ${C.gris}(Ctrl+C para cerrar; el robot sigue corriendo)${C.fin}\n`)
const iniciales = lineasDe(`logs/resumen-${fecha}.log`)
if (iniciales.length) {
  iniciales.slice(-10).forEach((l) => { console.log(pintar(l)); if (l.includes('--- corrida')) ultimaCorrida = Date.now() })
  lineasLeidas = iniciales.length
} else {
  console.log(`${C.gris}Aún no hay corridas hoy. Esperando...${C.fin}`)
}

// Revisar cada 2 s; avisar si pasan más de 12 min sin corridas (la tarea podría estar detenida)
let avisado = false
setInterval(() => {
  try { leerNuevas() } catch { /* archivo en uso: se lee en la siguiente vuelta */ }
  const min = ultimaCorrida ? (Date.now() - ultimaCorrida) / 60_000 : null
  if (min !== null && min > 12 && !avisado) {
    console.log(`${C.rojo}AVISO ${horaGT()}  Más de 12 min sin corridas: revisa la tarea "HPC Citas CSHP" (horario, batería o suspensión)${C.fin}`)
    avisado = true
  }
  if (min !== null && min <= 12) avisado = false
}, 2000)

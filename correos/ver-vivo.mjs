/**
 * Monitor en vivo del robot de correos: deja esta ventana abierta y cada corrida de la tarea
 * programada (cada 2 min) aparece aquí sola, con los correos enviados y los totales del día.
 *   npm.cmd run vivo     o doble clic en monitor.cmd
 * Ctrl+C para cerrar. Cerrar esta ventana NO detiene el robot.
 */
import { readFileSync, existsSync } from 'node:fs'

const TAREA = 'HPC Correos'
const AVISO_MIN = 6 // la tarea corre cada 2 min: más de 6 min sin corridas = algo pasa
const fechaGT = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' })
const horaGT = () => new Date().toLocaleTimeString('es-GT', { timeZone: 'America/Guatemala', hour12: false })
const C = { verde: '\x1b[32m', amarillo: '\x1b[33m', rojo: '\x1b[31m', gris: '\x1b[90m', cian: '\x1b[36m', negrita: '\x1b[1m', fin: '\x1b[0m' }

/** Horario de la tarea: lunes a sábado, 7:00 a 20:00 (hora de Guatemala) */
function enHorario() {
  const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Guatemala' }))
  const h = ahora.getHours() + ahora.getMinutes() / 60
  return ahora.getDay() !== 0 && h >= 7 && h < 20
}

function pintar(l) {
  if (/\sOK\s/.test(l)) return `${C.verde}+ ${l}${C.fin}`
  if (/\sERROR\s|corrida ERROR/.test(l)) return `${C.rojo}x ${l}${C.fin}`
  if (/\sREINTENTAR\s|con fallas/.test(l)) return `${C.amarillo}! ${l}${C.fin}`
  if (/OMITIDA/.test(l)) return `${C.gris}· ${l}${C.fin}`
  if (/--- corrida sin correos/.test(l)) return `${C.gris}· ${l}${C.fin}`
  if (/--- corrida/.test(l)) return `${C.negrita}= ${l}${C.fin}`
  return `  ${l}`
}

const lineasDe = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean) : [])
const hora = (l) => l.slice(0, 8)

let fecha = fechaGT()
let leidas = 0
let ultima = null // hora (ms) de la última corrida vista
let avisado = false

function totales(lineas) {
  const ok = lineas.filter((l) => /\sOK\s/.test(l)).length
  const reint = lineas.filter((l) => /\sREINTENTAR\s/.test(l)).length
  const err = lineas.filter((l) => /\sERROR\s|corrida ERROR/.test(l)).length
  const corridas = lineas.filter((l) => /--- corrida/.test(l))
  const primera = corridas[0] ? hora(corridas[0]) : '--'
  const ult = corridas.at(-1) ? hora(corridas.at(-1)) : '--'
  const color = err ? C.rojo : reint ? C.amarillo : C.cian
  return `${color}  Hoy: ${ok} enviado(s) · ${reint} reintento(s) · ${err} error(es) · ${corridas.length} corrida(s) · primera ${primera} · última ${ult}${C.fin}`
}

function encabezado() {
  console.clear()
  console.log(`${C.negrita}Robot de correos · monitor en vivo${C.fin}  ${C.gris}${fecha} · Ctrl+C cierra este monitor (el robot sigue)${C.fin}`)
  console.log(`${C.gris}  + enviado   ! reintento (vuelve a probar en la siguiente corrida)   x error: ver correos_cola.ultimo_error   · corrida sin correos${C.fin}\n`)
}

function leerNuevas() {
  const hoy = fechaGT()
  if (hoy !== fecha) { fecha = hoy; leidas = 0; ultima = null; encabezado() }
  const lineas = lineasDe(`logs/resumen-${fecha}.log`)
  if (lineas.length < leidas) leidas = 0
  for (const l of lineas.slice(leidas)) {
    console.log(pintar(l))
    if (/--- corrida|\sERROR\s/.test(l)) ultima = Date.now()
    if (/--- corrida/.test(l) && !/sin correos/.test(l)) console.log(totales(lineas))
  }
  leidas = lineas.length
}

// Al abrir: totales del día y las últimas 15 líneas
encabezado()
const iniciales = lineasDe(`logs/resumen-${fecha}.log`)
if (iniciales.length) {
  console.log(totales(iniciales) + '\n')
  iniciales.slice(-15).forEach((l) => console.log(pintar(l)))
  if (iniciales.some((l) => /--- corrida/.test(l))) ultima = Date.now()
  leidas = iniciales.length
} else {
  console.log(`${C.gris}Aún no hay corridas hoy. Esperando la siguiente...${C.fin}`)
}

setInterval(() => {
  try { leerNuevas() } catch { /* archivo en uso: se lee en la siguiente vuelta */ }
  const min = ultima ? (Date.now() - ultima) / 60_000 : null
  if (enHorario() && min !== null && min > AVISO_MIN && !avisado) {
    console.log(`${C.rojo}AVISO ${horaGT()}  Más de ${AVISO_MIN} min sin corridas: revisa que la PC no esté suspendida y que la tarea "${TAREA}" siga activa${C.fin}`)
    avisado = true
  }
  if (min !== null && min <= AVISO_MIN) avisado = false
}, 2000)

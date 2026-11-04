/**
 * Monitor en vivo del robot de guías: deja esta ventana abierta y cada corrida de la tarea
 * programada (cada 3 min) aparece aquí sola, con las llamadas impresas y los totales del día.
 *   npm.cmd run vivo     (desde C:\hpc-guias)   o doble clic en monitor.cmd
 * Ctrl+C para cerrar. Cerrar esta ventana NO detiene el robot.
 */
import { readFileSync, existsSync } from 'node:fs'

const TAREA = 'HPC Guias CSHP'
const AVISO_MIN = 8 // la tarea corre cada 3 min: más de 8 min sin corridas = algo pasa
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
  if (/\sERROR\s/.test(l)) return `${C.rojo}x ${l}${C.fin}`
  if (/OMITIDA/.test(l)) return `${C.amarillo}! ${l}${C.fin}`
  if (/--- corrida.*sin llamadas/.test(l)) return `${C.gris}· ${l}${C.fin}`
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
  const err = lineas.filter((l) => /\sERROR\s/.test(l)).length
  const corridas = lineas.filter((l) => /--- corrida/.test(l))
  const primera = corridas[0] ? hora(corridas[0]) : '--'
  const ult = corridas.at(-1) ? hora(corridas.at(-1)) : '--'
  const color = err ? C.rojo : C.cian
  return `${color}  Hoy: ${ok} llamada(s) impresa(s) · ${err} error(es) · ${corridas.length} corrida(s) · primera ${primera} · última ${ult}${C.fin}`
}

function encabezado() {
  console.clear()
  console.log(`${C.negrita}Robot de guías y diagnósticos · monitor en vivo${C.fin}  ${C.gris}${fecha} · Ctrl+C cierra este monitor (el robot sigue)${C.fin}`)
  console.log(`${C.gris}  + impresa (guía TSC + diagnóstico NODUS)   x error: ver REVISAR A MANO con npm.cmd run log   · corrida sin llamadas${C.fin}\n`)
}

function leerNuevas() {
  const hoy = fechaGT()
  if (hoy !== fecha) { fecha = hoy; leidas = 0; ultima = null; encabezado() }
  const lineas = lineasDe(`logs/resumen-${fecha}.log`)
  if (lineas.length < leidas) leidas = 0
  const nuevas = lineas.slice(leidas)
  for (const l of nuevas) {
    console.log(pintar(l))
    if (/--- corrida|\sERROR\s|OMITIDA/.test(l)) ultima = Date.now()
    // Después de cada corrida con trabajo o error, los totales del día
    if (/--- corrida/.test(l) && !/sin llamadas/.test(l)) console.log(totales(lineas))
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

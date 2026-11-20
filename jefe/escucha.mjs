/**
 * El Jefe escuchando Telegram TODO el tiempo: contesta en segundos (antes, en la ronda de cada 3 min).
 * Usa "long polling": Telegram le avisa apenas le escribes. Si algo no lo entiende y hay IA local,
 * despierta al cerebro al momento (no espera su tarea de cada 2 min).
 * Tarea "HPC Jefe Telegram" (programar-escucha.cmd): arranca al iniciar sesión y se revive sola cada 5 min si se cayó.
 *   node --env-file=.env escucha.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { telegramListo, procesarMensajes, marcarEscuchaViva, iaLista } from './telegram.mjs'
import { contextoTelegram, log, corto } from './contexto-telegram.mjs'

if (!telegramListo()) { console.log('Falta TELEGRAM_TOKEN / TELEGRAM_CHAT_ID en .env'); process.exit(1) }
const HASTA = Date.now() + 12 * 3600e3   // cada 12 h se reinicia sola (la tarea la vuelve a levantar)
const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

function despertarCerebro() {
  if (!iaLista() || !existsSync('cerebro/cola') || !readdirSync('cerebro/cola').some((f) => f.endsWith('.json'))) return
  spawn(process.execPath, ['--env-file=.env', 'cerebro.mjs'], { cwd: process.cwd(), detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

log('TELEGRAM escucha encendida')
let fallas = 0
while (Date.now() < HASTA) {
  marcarEscuchaViva()
  const ok = await procesarMensajes(contextoTelegram(), 25).catch((e) => { log(`Telegram escucha: ${corto(e, 150)}`); return false })
  despertarCerebro()
  if (ok) fallas = 0
  else await dormir(Math.min(60000, 5000 * ++fallas))   // sin red: espera un poco más cada vez (máx. 1 min)
}
log('TELEGRAM escucha: reinicio programado (12 h)')
process.exit(0)

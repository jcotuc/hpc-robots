/**
 * Robot de correos — toma correos_cola (Supabase ConsumosCS) y los envía por Microsoft 365.
 *   npm.cmd run qa        envía todo a REDIRIGIR_A (no le llega a nadie más)
 *   npm.cmd run prod      envío real
 *   npm.cmd run listar    ver la cola sin enviar
 *   npm.cmd run probar -- tucorreo@hpc.com.gt     correo de prueba (no usa la cola)
 */
import { createClient } from '@supabase/supabase-js'
import { mkdirSync, appendFileSync, writeFileSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crearMonitor } from '../shared/monitor.mjs'
import { armarCorreo } from './plantillas.mjs'

const args = process.argv.slice(2)
const AMBIENTE = args.includes('--prod') ? 'prod' : args.includes('--qa') ? 'qa' : (process.env.AMBIENTE || 'qa').toLowerCase()
const LISTAR = args.includes('--solo-listar')
const PROBAR = args.includes('--probar') ? args[args.indexOf('--probar') + 1] : null
const MODO = (process.env.CORREO_MODO || 'outlook').toLowerCase()     // outlook | smtp | graph
const REMITENTE = (process.env.CORREO_REMITENTE || '').trim()
const REDIRIGIR_A = (process.env.REDIRIGIR_A || '').trim()             // QA: todo va aquí
const MAX = Number(process.env.MAX_CORREOS || 20)
const MAX_INTENTOS = Number(process.env.MAX_INTENTOS || 5)
const INTERVALO_SEG = Number(process.env.INTERVALO_SEG || 120)

const fechaGT = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' })
const horaGT = () => new Date().toLocaleTimeString('es-GT', { timeZone: 'America/Guatemala', hour12: false })
const corto = (e) => String(e?.message || e || '').split('\n')[0].slice(0, 400)
const mon = crearMonitor('correos', { intervaloSeg: INTERVALO_SEG, activo: AMBIENTE === 'prod' && !LISTAR && !PROBAR })

function log(l) {
  console.log(l)
  try { mkdirSync('logs', { recursive: true }); appendFileSync(`logs/detalle-${fechaGT()}.log`, `${horaGT()}  ${l}\r\n`) } catch {}
}
function resumen(l) {
  log(l)
  try { appendFileSync(`logs/resumen-${fechaGT()}.log`, `${horaGT()}  ${l}\r\n`) } catch {}
}

/* ---------- Envío ---------- */
let tokenGraph = null
async function graphToken() {
  if (tokenGraph && tokenGraph.vence > Date.now() + 60000) return tokenGraph.valor
  const { GRAPH_TENANT_ID: t, GRAPH_CLIENT_ID: id, GRAPH_CLIENT_SECRET: s } = process.env
  if (!t || !id || !s) throw new Error('Faltan GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET en .env')
  const r = await fetch(`https://login.microsoftonline.com/${t}/oauth2/v2.0/token`, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: s, scope: 'https://graph.microsoft.com/.default' }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`Token Graph HTTP ${r.status}: ${j.error_description || j.error || ''}`)
  tokenGraph = { valor: j.access_token, vence: Date.now() + j.expires_in * 1000 }
  return tokenGraph.valor
}

let smtp = null
/** Outlook de escritorio (COM). Requiere Outlook clásico con la cuenta abierta en esta sesión de Windows. */
function enviarOutlook(correo) {
  const archivo = join(tmpdir(), `hpc-correo-${process.pid}-${Date.now()}.json`)
  writeFileSync(archivo, JSON.stringify({ ...correo, de: REMITENTE || null }), 'utf8')
  return new Promise((ok, mal) => execFile('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./outlook-enviar.ps1', import.meta.url)), '-Archivo', archivo],
    { timeout: 60000, windowsHide: true },
    (e, out, err) => {
      try { unlinkSync(archivo) } catch {}
      if (e || !/ENVIADO/.test(out)) {
        const msg = (String(out).match(/ERROR: (.*)/)?.[1] || String(err).trim().split(/\r?\n/).find(Boolean) || e?.message || '').trim()
        return mal(new Error(`Outlook: ${msg}`))
      }
      ok()
    }))
}

async function enviar({ para, cc = [], asunto, html }) {
  if (MODO === 'outlook') return enviarOutlook({ para, cc, asunto, html })
  if (!REMITENTE) throw new Error('Falta CORREO_REMITENTE en .env')
  if (MODO === 'smtp') {
    if (!smtp) {
      const nodemailer = (await import('nodemailer')).default
      smtp = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.office365.com', port: Number(process.env.SMTP_PORT || 587),
        secure: false, requireTLS: true, auth: { user: process.env.SMTP_USUARIO || REMITENTE, pass: process.env.SMTP_PASSWORD },
      })
    }
    await smtp.sendMail({ from: REMITENTE, to: para, cc, subject: asunto, html })
    return
  }
  const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(REMITENTE)}/sendMail`, {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${await graphToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: asunto, body: { contentType: 'HTML', content: html },
        toRecipients: para.map((a) => ({ emailAddress: { address: a } })),
        ccRecipients: cc.map((a) => ({ emailAddress: { address: a } })),
      },
      saveToSentItems: true,
    }),
  })
  if (!r.ok) throw new Error(`Graph sendMail HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`)
}

/** En QA todo va a REDIRIGIR_A, con los destinatarios reales en el asunto */
function destino(fila, correo) {
  if (AMBIENTE === 'prod' && !REDIRIGIR_A) return { para: fila.para, cc: fila.cc || [], asunto: correo.asunto }
  if (!REDIRIGIR_A) throw new Error('En QA hay que poner REDIRIGIR_A en .env (a quién mandar las pruebas)')
  return { para: [REDIRIGIR_A], cc: [], asunto: `[${AMBIENTE.toUpperCase()} → ${[...fila.para, ...(fila.cc || [])].join(', ')}] ${correo.asunto}` }
}

/* ---------- Corrida ---------- */
function candado() {
  try { const fd = openSync('.correos.lock', 'wx'); closeSync(fd); return true } catch {
    try { if (Date.now() - statSync('.correos.lock').mtimeMs > 10 * 60000) { unlinkSync('.correos.lock'); return candado() } } catch {}
    return false
  }
}

async function main() {
  if (PROBAR) {
    await enviar({ para: [PROBAR], asunto: 'Prueba robot de correos HPC', html: `<p>Prueba del robot de correos (${MODO}) desde ${REMITENTE} — ${new Date().toLocaleString('es-GT', { timeZone: 'America/Guatemala' })}</p>` })
    return log(`OK prueba enviada a ${PROBAR} (${MODO})`)
  }
  if (!candado()) return resumen('OMITIDA corrida: otra sigue en curso')
  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    if (LISTAR) {
      const { data, error } = await sb.from('correos_cola').select('id, tipo, para, referencia, estado, intentos, ultimo_error, created_at')
        .in('estado', ['pendiente', 'enviando', 'error']).order('created_at').limit(100)
      if (error) throw error
      console.table(data)
      return
    }
    const { data: filas, error } = await sb.rpc('correos_tomar', { p_max: MAX })
    if (error) throw new Error(`correos_tomar: ${error.message}`)
    if (!filas.length) { mon.fin('Sin pendientes'); return resumen('--- corrida sin correos') }

    mon.trabajando(null, `${filas.length} correo(s) por enviar`)
    let ok = 0, fallo = 0
    for (const f of filas) {
      const ref = f.referencia || `#${f.id}`
      try {
        mon.trabajando(ref, `Enviando ${f.tipo}`)
        const correo = armarCorreo(f)
        await enviar({ ...destino(f, correo), html: correo.html })
        await sb.from('correos_cola').update({ estado: 'enviado', enviado_en: new Date().toISOString(), intentos: f.intentos + 1, ultimo_error: null }).eq('id', f.id)
        ok++; mon.ok(ref, `${f.tipo} → ${f.para.join(', ')}`); resumen(`OK ${f.tipo} ${ref} → ${f.para.join(', ')}`)
      } catch (e) {
        fallo++
        const intentos = f.intentos + 1
        const final = intentos >= MAX_INTENTOS
        await sb.from('correos_cola').update({ estado: final ? 'error' : 'pendiente', intentos, ultimo_error: corto(e) }).eq('id', f.id)
        resumen(`${final ? 'ERROR' : 'REINTENTAR'} ${f.tipo} ${ref} (intento ${intentos}/${MAX_INTENTOS}): ${corto(e)}`)
        if (final) mon.error(e, ref); else mon.revisar(ref, `Reintento ${intentos}: ${corto(e)}`)
      }
    }
    mon.fin(`${ok} enviado(s)${fallo ? ` · ${fallo} con falla` : ''}`)
    resumen(`--- corrida ${fallo ? 'con fallas' : 'OK'}: ${ok} enviado(s), ${fallo} con falla`)
  } finally {
    try { unlinkSync('.correos.lock') } catch {}
  }
}

main()
  .catch((e) => { resumen(`--- corrida ERROR  ${corto(e)}`); mon.error(e); process.exitCode = 1 })
  .finally(() => mon.flush())

/**
 * Sync script — reads pending garantias from Supabase and inserts them
 * into the HPC service-call system via Playwright.
 *
 * Run (a mano):  doble clic en correr.cmd  (producción)  ·  npm.cmd run qa  (QA)
 *
 * Uses SYNC_QA_URL by default. Set SYNC_ENV=prod to target production.
 * Reporta al Dungeon de Robots (shared/monitor.mjs) cuando corre en producción.
 */

import { chromium, Page } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
import { mkdirSync } from 'node:fs'
// @ts-ignore — módulo JS compartido por todos los robots
import { crearMonitor } from '../shared/monitor.mjs'

dotenv.config({ path: '.env' })
dotenv.config({ path: '.env.local' })   // compatibilidad con el repo de la app

// ─── Config ────────────────────────────────────────────────────────────

const ENV      = process.env.SYNC_ENV === 'prod' ? 'prod' : 'qa'
const BASE_URL = ENV === 'prod' ? process.env.SYNC_PROD_URL! : process.env.SYNC_QA_URL!
const USERNAME = process.env.SYNC_USERNAME!
const PASSWORD = process.env.SYNC_PASSWORD!

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

// Robot manual: no tiene horario fijo; el dungeon lo manda a la cafetería si no hay NDC pendientes
const mon = crearMonitor('garantias', { intervaloSeg: 1800, activo: ENV === 'prod' })
mkdirSync('capturas', { recursive: true })

if (!BASE_URL) {
  console.error('❌  BASE_URL is not set. Check SYNC_QA_URL / SYNC_PROD_URL in .env.local')
  process.exit(1)
}

// ─── Login ───────────────────────────────────────────────────────────────────

function needsLogin(page: Page): boolean {
  const url = page.url()
  return url.includes('Login') || url.includes('BloqSeguridad')
}

async function doLogin(page: Page) {
  // Always start from the login page directly
  await page.goto(`${BASE_URL}/Login.aspx`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForLoadState('domcontentloaded')

  console.log('🔐  Logging in…')
  await page.locator('input[type="text"]').first().fill(USERNAME)
  await page.locator('input[type="password"]').first().fill(PASSWORD)
  await page.locator('input[type="image"], input[type="submit"], button[type="submit"]').first().click()
  await page.waitForLoadState('networkidle')

  if (needsLogin(page)) {
    throw new Error('Login failed — still on Login/BloqSeguridad after submitting credentials')
  }
  console.log('✅  Logged in — current URL:', page.url())
}

async function ensureLoggedIn(page: Page) {
  await page.goto(`${BASE_URL}/LLamadasServ.aspx`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForLoadState('domcontentloaded')

  if (needsLogin(page)) {
    console.log('⚠️  Not authenticated — logging in…')
    await doLogin(page)
  } else {
    console.log('✅  Session already active — skipping login')
  }
}

// ─── Fill one record ─────────────────────────────────────────────────────────

async function fillRecord(page: Page, record: Record<string, any>): Promise<string | null> {
  // Go to list page and click Nueva to open the new record form
  await page.goto(`${BASE_URL}/LLamadasServ.aspx`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForLoadState('domcontentloaded')
  console.log('➕  Clicking Nueva…')
  await page.locator('#FrmLLamadasServ_CmdNueva').click()

  // Wait for the entry form to actually render (TxtCliente is only present in form mode)
  await page.waitForSelector('#FrmLLamadasServ_TxtCliente', { state: 'visible', timeout: 15_000 })
  console.log('📋  Entry form loaded')

  // ── Llamada Logística radio (value="S") — may trigger postback ──
  await page.locator('#FrmLLamadasServ_OpOrigen_0').check()
  await page.waitForLoadState('networkidle')

  // ── Cliente SAP radio (value="S") — may trigger postback ──
  await page.locator('#FrmLLamadasServ_OpTipoIngreso_0').check()
  await page.waitForLoadState('networkidle')

  // ── Client code — blur triggers a lookup postback, so wait for it before filling other fields ──
  await page.locator('#FrmLLamadasServ_TxtCliente').click()
  await page.locator('#FrmLLamadasServ_TxtCliente').fill('')
  await page.locator('#FrmLLamadasServ_TxtCliente').type(record.codigo_cliente)
  await page.locator('#FrmLLamadasServ_TxtCliente').press('Tab')
  await page.waitForLoadState('networkidle')

  // ── Centro de servicio → Z6 HPCS016 (se fija después del lookup del cliente, que puede cambiarlo) ──
  await page.locator('#FrmLLamadasServ_CmbCentro').selectOption('HPCS016')
  await page.waitForLoadState('networkidle')
  const centroFinal = await page.locator('#FrmLLamadasServ_CmbCentro').inputValue()
  if (centroFinal !== 'HPCS016') {
    throw new Error(`Centro de servicio incorrecto — esperado "HPCS016", quedo "${centroFinal}"`)
  }

  // ── SKU (filled after client lookup postback settles) ──
  await page.locator('#FrmLLamadasServ_TxtSKU').click()
  await page.locator('#FrmLLamadasServ_TxtSKU').fill('')
  await page.locator('#FrmLLamadasServ_TxtSKU').type(record.sku_reportado)

  // ── Cantidad ──
  // The form sometimes keeps its own default "1" in this field instead of
  // letting fill('') clear it, so typing on top of it silently produces
  // "11" instead of "1". Verify the value that actually landed and retry
  // (clear + retype) until it matches what we meant to send.
  const cantidadEsperada = String(record.cantidad_sku)
  const txtCantidad = page.locator('#FrmLLamadasServ_TxtCantidad')
  console.log(`   Cantidad a ingresar: ${cantidadEsperada}`)

  let cantidadFinal = ''
  for (let intento = 1; intento <= 3; intento++) {
    await txtCantidad.click()
    await txtCantidad.press('Control+A')
    await txtCantidad.press('Delete')
    await txtCantidad.fill('')
    await txtCantidad.type(cantidadEsperada)
    cantidadFinal = await txtCantidad.inputValue()
    if (cantidadFinal === cantidadEsperada) break
    console.warn(`⚠️  Cantidad no coincide (intento ${intento}/3) — esperado "${cantidadEsperada}", quedo "${cantidadFinal}". Reintentando...`)
  }

  console.log(`✅  Cantidad confirmada en el formulario: ${cantidadFinal}`)
  if (cantidadFinal !== cantidadEsperada) {
    throw new Error(`Cantidad incorrecta tras 3 intentos — esperado "${cantidadEsperada}", quedo "${cantidadFinal}"`)
  }

  // ── Tipología → Garantía Herr Manual ──
  await page.locator('#FrmLLamadasServ_CmbTipologia').selectOption({ label: 'Garantía Herr Manual' })

  // ── Garantía radio (value="1") ──
  await page.locator('#FrmLLamadasServ_OpModo_0').check()

  // ── Estado en que ingresa Máquina ──
  const estadoText = [record.descripcion_problema, record.descripcion_sku || null]
    .filter(Boolean).join('\n')
  await page.locator('#FrmLLamadasServ_TxtComentario').fill(estadoText)

  // ── Submit (image input — use JS click to ensure coordinates are sent) ──
  await page.evaluate(() => {
    (document.querySelector('#FrmLLamadasServ_CmdAceptar') as HTMLElement).click()
  })
  await page.waitForLoadState('networkidle')

  // ── Confirmation: wait for TxtCodigo to have a value ──
  // TxtCodigo is the Número field — only populated after a successful save
  let externalId: string | null = null
  try {
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#FrmLLamadasServ_TxtCodigo')
        return el && (el.textContent || '').trim().length > 0
      },
      { timeout: 10_000 }
    )
    externalId = (await page.locator('#FrmLLamadasServ_TxtCodigo').innerText()).trim() || null
    if (externalId) console.log(`🔑  Número confirmed: ${externalId}`)
  } catch {
    const errText = await page.locator('#FrmLLamadasServ_LblError').innerText().catch(() => '')
    throw new Error(`Record creation failed — ${errText || 'Número not populated after submit'}`)
  }

  if (!externalId) {
    throw new Error('Record creation unconfirmed — Número empty after submission.')
  }

  return externalId
}

// ─── Change status in the Cambio de Status modal ─────────────────────────────

async function changeStatus(page: Page) {
  // ── Cambiar Status — same-page modal overlay ──
  await page.evaluate(() => {
    (document.querySelector('#FrmLLamadasServ_CmdCambiarStatus') as HTMLElement).click()
  })

  // Nuevo Status dropdown — select "TLS - NC Autorizada"
  await page.waitForSelector('#FrmLLamadasServ_CmbStatusN', { state: 'visible', timeout: 10_000 })
  await page.locator('#FrmLLamadasServ_CmbStatusN').selectOption({ label: 'TLS - NC Autorizada' })
  await page.waitForLoadState('networkidle')

  // Scroll the modal div then click the correct Aceptar button (CmdAceptarCambio)
  await page.evaluate(() => {
    const div = document.querySelector('#FrmLLamadasServ_DivStatus') as HTMLElement
    if (div) div.scrollTop = div.scrollHeight
  })
  await page.locator('#FrmLLamadasServ_CmdAceptarCambio').click()
  await page.waitForLoadState('networkidle')
  console.log(`✅  Status changed to TLS - NC Autorizada`)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🚀  Starting sync — environment: ${ENV.toUpperCase()}\n`)
  mon.trabajando(null, 'Buscando NDC pendientes')
  let ok = 0, fallas = 0

  // Only records already reviewed/approved as NDC ("Nota de Crédito") should be
  // pushed into the taller system. Records still sitting as NUE/CXG/INC haven't
  // been approved yet and must NOT be synced just because sync_status='pending'.
  // Atomic claim: mark rows as claimed by stamping last_sync_attempt_at with 'now', in the same statement that
  // selects them; the .or() below skips rows whose lease hasn't expired yet,
  const LEASE_MINUTES = 10
    const leaseCutoff = new Date(Date.now() - LEASE_MINUTES * 60 * 1000).toISOString()
      
  const { data: records, error } = await supabase
    .from('garantias_manuales')
    .update({ last_sync_attempt_at: new Date().toISOString() })
    .eq('sync_status', 'pending')
    .eq('record_status', 'NDC')
    .or(`last_sync_attempt_at.is.null,last_sync_attempt_at.lt.${leaseCutoff}`)
    .eq('deleted', false)
    .select('*')
    .order('created_at', { ascending: true })

  if (error) { console.error('Supabase error:', error); mon.error(`Supabase: ${error.message}`); await mon.flush(); process.exit(1) }
  if (!records?.length) { console.log('✅  No pending NDC records.'); mon.fin('Sin NDC pendientes'); return }

  console.log(`📋  Found ${records.length} pending NDC record(s)\n`)

  // Runs headless automatically in CI (GitHub Actions) or when SYNC_HEADLESS=true;
  // stays visible with slowMo for local manual debugging otherwise.
  const HEADLESS = process.env.CI === 'true' || process.env.SYNC_HEADLESS === 'true'
  const browser = await chromium.launch({ headless: HEADLESS, slowMo: HEADLESS ? 0 : 200 })
  const context = await browser.newContext()
  const page    = await context.newPage()

  try {
    await ensureLoggedIn(page)

    for (const record of records) {
      console.log(`⏳  Processing record ${record.id} — cliente: ${record.codigo_cliente}`)
      mon.trabajando(null, `NDC cliente ${record.codigo_cliente}`)
      try {
        // Phase 1 — create record in HPC and get the confirmation number
        const externalId = await fillRecord(page, record)
        if (externalId) mon.trabajando(externalId, `NDC cliente ${record.codigo_cliente}`)

        // The external record now exists. If saving that back to Supabase
        // fails, DO NOT let it fall into the retry/duplicate logic below —
        // retrying would create a SECOND external record. Flag for manual
        // review instead.
        const { error: syncUpdateErr } = await supabase
          .from('garantias_manuales')
          .update({
            sync_status: 'synced',
            synced_at: new Date().toISOString(),
            external_id: externalId,
            last_sync_attempt_at: new Date().toISOString(),
          })
          .eq('id', record.id)

        if (syncUpdateErr) {
          console.error(`⚠️  Created externally (Número: ${externalId}) but failed to save to Supabase for ${record.id}: ${syncUpdateErr.message}`)
          mon.revisar(externalId, `garantia_ndc · creada pero no se guardó en Supabase: revisar ${record.id}`)
          await supabase
            .from('garantias_manuales')
            .update({
              sync_status: 'needs_review',
              external_id: externalId,
              last_sync_attempt_at: new Date().toISOString(),
            })
            .eq('id', record.id)
          continue
        }

        console.log(`✅  Synced: ${record.id} — Número: ${externalId}`)
        ok++; mon.ok(externalId, `garantia_ndc · cliente ${record.codigo_cliente} · NC creada`)

        // Phase 2 — change status in the modal (best-effort; stays 'synced' if it fails)
        try {
          await changeStatus(page)
          await supabase
            .from('garantias_manuales')
            .update({
              sync_status: 'status_updated',
              last_sync_attempt_at: new Date().toISOString(),
            })
            .eq('id', record.id)
          console.log(`✅  Status updated: ${record.id}`)
        } catch (statusErr: any) {
          console.warn(`⚠️  Status change failed for ${record.id} — left as synced. ${statusErr.message}`)
          mon.revisar(externalId, `garantia_ndc · no se pudo cambiar a NC Autorizada: ${statusErr.message}`)
          await page.screenshot({ path: `capturas/status-error-${record.id}.png` })
        }

      } catch (err: any) {
        const isDuplicate = /duplicat|ya existe|already/i.test(err.message ?? '')

        if (isDuplicate) {
          await supabase
            .from('garantias_manuales')
            .update({
              sync_status: 'duplicated',
              last_sync_attempt_at: new Date().toISOString(),
            })
            .eq('id', record.id)
          console.error(`❌  duplicated — ${record.id}: ${err.message}`)
          fallas++; mon.revisar(null, `garantia_ndc · duplicada ${record.id}: ${err.message}`)
        } else {
          const retries = (record.sync_retries ?? 0) + 1
          if (retries >= 3) {
            await supabase
              .from('garantias_manuales')
              .update({
                sync_status: 'rejected',
                sync_retries: retries,
                last_sync_attempt_at: new Date().toISOString(),
              })
              .eq('id', record.id)
            console.error(`❌  rejected after ${retries} attempts — ${record.id}: ${err.message}`)
            fallas++; mon.error(`garantia_ndc · rechazada ${record.id} (3 intentos): ${err.message}`)
          } else {
            await supabase
              .from('garantias_manuales')
              .update({
                sync_status: 'pending',
                sync_retries: retries,
                last_sync_attempt_at: new Date().toISOString(),
              })
              .eq('id', record.id)
            console.error(`❌  failed (attempt ${retries}/3, will retry) — ${record.id}: ${err.message}`)
            fallas++; mon.revisar(null, `garantia_ndc · intento ${retries}/3 ${record.id}: ${err.message}`)
          }
          await page.screenshot({ path: `capturas/error-${record.id}.png` })
        }
      }
    }
  } finally {
    await browser.close()
  }

  console.log('\n🏁  Sync complete.')
  mon.fin(`${ok} NDC sincronizada(s)${fallas ? ` · ${fallas} con problema` : ''}`)
}

main()
  .catch(async (e: any) => { console.error('❌', e?.message || e); mon.error(e); process.exitCode = 1 })
  .finally(() => mon.flush())

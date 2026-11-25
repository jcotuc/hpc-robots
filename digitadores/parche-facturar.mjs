// Parche: el robot confirma que CSHP sí facturó (antes podía seguir aunque el botón Facturar no estuviera).
//   cd C:\Users\jcotuc\source\repos\hpc-robots\digitadores
//   node parche-facturar.mjs
import { readFileSync, writeFileSync } from 'node:fs'
const f = 'digitar-garantia.mjs'
const raw = readFileSync(f, 'utf8')
const crlf = raw.includes('\r\n')
let s = raw.replace(/\r\n/g, '\n')
if (s.includes('// PARCHE-FACTURAR')) { console.log('Ya estaba aplicado'); process.exit(0) }
const viejo = `async function facturar(page) {
  let aviso = ''
  const alAviso = (dialog) => { aviso = dialog.message(); dialog.accept().catch(() => {}) }
  page.once('dialog', alAviso)
  await clic(page, '#FrmLLamadasServ_CmdFacturar')
  await esperarCSHP(page)
  page.off('dialog', alAviso)
  await revisarError(page, 'Facturar')
  return aviso
}`
const nuevo = `// PARCHE-FACTURAR: el botón tiene que existir y CSHP tiene que confirmar la facturación
// (aviso "Se registro facturación" o un T - Pend. Entrega nuevo en el log). Si no, error y se detiene.
async function facturar(page) {
  const boton = page.locator('#FrmLLamadasServ_CmdFacturar')
  if (!(await boton.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false))) {
    throw new Error('CSHP no muestra el botón Facturar: la llamada NO se facturó')
  }
  const antes = await vecesEnLog(page, 'T - Pend. Entrega')
  const avisos = []
  const alAviso = (dialog) => { avisos.push(dialog.message()); dialog.accept().catch(() => {}) }
  page.on('dialog', alAviso)
  try {
    await boton.click({ timeout: 10_000 })
    await esperarCSHP(page)
    // Espera hasta 30 s el aviso de CSHP o el renglón nuevo en el log
    for (let i = 0; i < 30 && !avisos.some((t) => /factur/i.test(t)); i++) {
      if ((await vecesEnLog(page, 'T - Pend. Entrega')) > antes) break
      await page.waitForTimeout(1_000)
    }
  } finally { page.off('dialog', alAviso) }
  await revisarError(page, 'Facturar')
  const aviso = avisos.join(' / ')
  const confirmada = /registr\\w* facturaci/i.test(aviso) || (antes >= 0 && (await vecesEnLog(page, 'T - Pend. Entrega')) > antes)
  if (!confirmada) throw new Error(\`CSHP no confirmó la facturación\${aviso ? \` (aviso: \${aviso})\` : ' (sin aviso)'}\`)
  return aviso
}`
if (!s.includes(viejo)) { console.error('No encontré la función facturar original: avísale a Claude'); process.exit(1) }
s = s.replace(viejo, nuevo)
writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s)
console.log('Parche aplicado en ' + f)

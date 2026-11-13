/**
 * Muestra el esquema REAL de la app de repuestos en Supabase (tablas rep_*, equivalencias y funciones rep_*).
 * SOLO LECTURA: lee la descripción OpenAPI de la Data API. No lee ni cambia datos.
 *   node --env-file=.env esquema.mjs > C:\Users\jcotuc\Downloads\esquema-repuestos.txt
 */
const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '')
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) { console.error('❌ Falta SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env'); process.exit(1) }

const r = await fetch(`${url}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/openapi+json' } })
if (!r.ok) { console.error(`❌ HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`); process.exit(1) }
const api = await r.json()
const defs = api.definitions || api.components?.schemas || {}
const interesa = (n) => /^rep_|^equivalencias$|^sustitutos$|^repuesto_maquinas$|^robot_status$|^robot_eventos$/.test(n)

console.log(`Supabase: ${url}\n\n=== TABLAS ===`)
for (const [n, d] of Object.entries(defs).filter(([n]) => interesa(n)).sort()) {
  console.log(`\n${n}`)
  const req = new Set(d.required || [])
  for (const [c, p] of Object.entries(d.properties || {})) {
    const desc = String(p.description || '').replace(/\s+/g, ' ')
    const fk = (desc.match(/<fk table='(\w+)' column='(\w+)'\/>/) || []).slice(1)
    console.log(`  ${c.padEnd(26)} ${String(p.format || p.type || '').padEnd(26)}${req.has(c) ? ' obligatorio' : ''}${p.default !== undefined ? ` default=${p.default}` : ''}${p.enum ? ` valores=${p.enum.join('|')}` : ''}${fk.length ? ` → ${fk.join('.')}` : ''}`)
  }
}

console.log('\n=== FUNCIONES (RPC) ===')
for (const [ruta, m] of Object.entries(api.paths || {}).filter(([p]) => /^\/rpc\/(rep_|.*equivalen)/.test(p)).sort()) {
  const post = m.post || m.get || {}
  const body = (post.parameters || []).find((x) => x.in === 'body')?.schema
  const props = body?.properties || {}
  const req = new Set(body?.required || [])
  console.log(`\n${ruta.replace('/rpc/', '')}(${Object.entries(props).map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${v.format || v.type}`).join(', ')})`)
  if (post.description || post.summary) console.log(`  ${String(post.description || post.summary).replace(/\s+/g, ' ').slice(0, 300)}`)
}

console.log('\n=== CONFIG (rep_config) ===')
const c = await fetch(`${url}/rest/v1/rep_config?select=clave,valor`, { headers: { apikey: key, Authorization: `Bearer ${key}` } })
console.log(c.ok ? JSON.stringify(await c.json(), null, 1) : `HTTP ${c.status}`)

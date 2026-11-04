/**
 * Revisa que el worker esté bien configurado, sin crear nada:
 *   1. El archivo .env tiene usuario, contraseña y key bien escritos
 *   2. Esta PC llega a Supabase y la key funciona
 *   3. Esta PC llega a CSHP (QA y producción)
 * Uso (en la raíz del repo):  npm.cmd run sync:probar
 */
const ok = (t) => console.log(`  [OK]    ${t}`)
const mal = (t, arreglo) => { console.log(`  [MAL]   ${t}`); if (arreglo) console.log(`          -> ${arreglo}`); errores++ }
let errores = 0

// Caracteres invisibles (p. ej. al presionar Ctrl+V donde no se puede pegar)
const raro = (v) => /[\u0000-\u001f\u007f\u2018\u2019\u201c\u201d]/.test(v) || /^\s|\s$/.test(v)

console.log('\nPrueba de configuración del robot de MiMO\n')

console.log('1) Archivo worker\\.env')
const usuario = process.env.CSHP_USUARIO || ''
const pass = process.env.CSHP_PASSWORD || ''
const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const editar = 'Abre el archivo con:  notepad C:\\hpc-mimo\\worker\\.env'

if (!usuario || raro(usuario)) mal('CSHP_USUARIO vacío o con caracteres raros', editar); else ok(`Usuario CSHP: ${usuario}`)
if (!pass || raro(pass)) mal('CSHP_PASSWORD vacía o con caracteres raros', `${editar}  y escribe:  CSHP_PASSWORD='tu contraseña'`); else ok(`Contraseña CSHP escrita (${pass.length} caracteres)`)
if (url !== 'https://kkzovradqpptmsaakqlb.supabase.co') mal(`SUPABASE_URL incorrecta: ${JSON.stringify(url)}`, 'Debe ser exactamente: SUPABASE_URL=https://kkzovradqpptmsaakqlb.supabase.co'); else ok('Dirección de Supabase')
if (!key.startsWith('eyJ') || key.split('.').length !== 3 || raro(key)) mal('SUPABASE_SERVICE_ROLE_KEY vacía o mal pegada', `${editar}  y pega la key completa entre comillas simples`); else ok(`Key de Supabase con formato correcto (${key.length} caracteres)`)

console.log('\n2) Conexión a Supabase')
if (url && key.startsWith('eyJ') && !raro(key)) {
  try {
    const r = await fetch(`${url}/rest/v1/mimo_equipos?select=id&sync_status=eq.listo`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact', Range: '0-0' },
    })
    if (r.ok || r.status === 206) {
      const total = (r.headers.get('content-range') || '').split('/')[1] ?? '?'
      ok(`Supabase responde. Equipos en "Pendiente" ahora: ${total}`)
    } else mal(`Supabase rechazó la key (código ${r.status})`, 'Copia otra vez la key service_role desde Supabase')
  } catch (e) {
    mal(`No se pudo conectar a Supabase (${e.cause?.code || e.cause?.message || e.message})`, 'Revisa internet o pide a sistemas permitir *.supabase.co')
  }
} else console.log('  (se omite: primero corrige el .env)')

console.log('\n3) Conexión a CSHP')
for (const [nombre, base] of [['QA', process.env.CSHP_QA_URL || 'https://tallerqa.hpc.com.gt/CSHP'], ['Producción', process.env.CSHP_PROD_URL || 'https://taller.hpc.com.gt/CSHP']]) {
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/Login.aspx`, { signal: AbortSignal.timeout(15_000) })
    if (r.status < 500) ok(`CSHP ${nombre} responde`)
    else mal(`CSHP ${nombre} respondió con error ${r.status}`)
  } catch (e) {
    if (/CERT|SSL|TLS/i.test(String(e.cause?.code || e.cause?.message))) { ok(`CSHP ${nombre} responde (certificado interno)`); continue }
    mal(`No se pudo abrir CSHP ${nombre} (${e.cause?.code || e.name})`, 'Esta PC debe estar en la red de HPC (o VPN)')
  }
}

console.log(errores ? `\nResultado: hay ${errores} problema(s). Corrígelos y vuelve a correr la prueba.\n` : '\nResultado: TODO BIEN. Ya puedes usar el robot.\n')
process.exit(0) // siempre 0: así npm no muestra mensajes de error en rojo que asusten

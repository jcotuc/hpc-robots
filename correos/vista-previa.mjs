// Genera los machotes con datos de ejemplo en vista-previa\*.html (no envía nada).
//   npm.cmd run vista      y abrir los .html con doble clic
import { mkdirSync, writeFileSync } from 'node:fs'
import { armarCorreo } from './plantillas.mjs'

const items = [
  { sku: '1100123', descripcion: 'Carbones para rotomartillo 1/2"', cantidad: 2 },
  { sku: '1100456', descripcion: 'Grasa para engranajes 100 g', cantidad: 1 },
]
const ejemplos = {
  autoconsumo_solicitud: { numero: 'AC-0123', solicitante: 'Técnico Ejemplo', centro: 'HPCS012 Zona 12', fecha: new Date().toISOString(), tipologia: 'Taller', comentario: 'Mantenimiento de herramienta del taller', total: 'Q 185.00', items, url: '#' },
  autoconsumo_aprobado: { numero: 'AC-0123', resultado: 'autorizado', tipologia: 'Taller', total: 'Q 185.00', autorizador: 'Autorizador Ejemplo', centro: 'HPCS012 Zona 12', fecha: new Date().toISOString(), comentario: 'Ok, proceder.', items, url: '#' },
  autoconsumo_rechazado: { numero: 'AC-0123', resultado: 'rechazado', autorizador: 'Autorizador Ejemplo', centro: 'HPCS012 Zona 12', fecha: new Date().toISOString(), tipologia: 'Taller', total: 'Q 185.00', motivo_rechazo: 'Usar el repuesto de bodega B003.', items, url: '#' },
}
const gar = { caso: 'Cambio por garantía', numero: 'LLS21-123456', llamada: 'LLS21-123456', centro: 'HPCS012 Zona 12', solicitante: 'Técnico Ejemplo', tipologia: 'Defecto de fábrica', sku_viejo: '2200111', desc_viejo: 'Taladro percutor 1/2" 650W', sku_nuevo: '2200111', desc_nuevo: 'Taladro percutor 1/2" 650W', precio: 'Q 649.00', comentario: 'Motor quemado a los 15 días', fecha: new Date().toISOString(), vb_taller: 'jefe.taller@hpc.com.gt', url: '#' }
const nc = { ...gar, caso: 'Nota de crédito', tipologia: 'Nota de crédito', desc_nuevo: 'Nota de crédito', precio: null }
Object.assign(ejemplos, {
  garantia_taller: { ...gar }, garantia_pendiente: { ...gar }, garantia_digitador: { ...gar, autorizador: 'supervisor@hpc.com.gt' },
  garantia_resuelto_ok: { ...gar, resultado: 'autorizado', autorizador: 'supervisor@hpc.com.gt', resuelto_en: new Date().toISOString() },
  nc_pendiente: { ...nc }, nc_resuelto_rechazo: { ...nc, resultado: 'rechazado', autorizador: 'supervisor@hpc.com.gt', resuelto_en: new Date().toISOString(), motivo_rechazo: 'La foto no muestra la falla.' },
})
Object.assign(ejemplos, { autoconsumo_teleservicio: { numero: '3B7529D4', solicitante: 'Técnico Ejemplo', centro: 'HPCS012 Zona 12', tipologia: 'Taller', autorizador: 'autorizador@hpc.com.gt', resuelto_en: new Date().toISOString(), total: 'Q 185.00', items, url: '#' } })
const TIPO = { autoconsumo_teleservicio: 'autoconsumo_teleservicio', garantia_resuelto_ok: 'garantia_resuelto', nc_pendiente: 'garantia_pendiente', nc_resuelto_rechazo: 'garantia_resuelto' }
mkdirSync('vista-previa', { recursive: true })
for (const [nombre, datos] of Object.entries(ejemplos)) {
  const tipo = TIPO[nombre] || (nombre.startsWith('garantia') ? nombre : nombre.startsWith('autoconsumo_solicitud') ? 'autoconsumo_solicitud' : 'autoconsumo_resuelto')
  const c = armarCorreo({ tipo, datos })
  writeFileSync(`vista-previa/${nombre}.html`, c.html.replace('<body', `<body data-asunto="${c.asunto}"`), 'utf8')
  console.log(`${nombre}.html  ·  Asunto: ${c.asunto}`)
}

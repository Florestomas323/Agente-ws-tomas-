// Disponibilidad y citas.
// Reglas: cualquier hora dentro del horario de atención (por día), máximo N citas en el mismo lapso
// por cada persona que atiende. Presencial: en la hora local de la zona. Meet: dentro del horario de Tomás (Texas).
// Si hay Apps Script (CALENDARIO_URL), crea el evento en Google Calendar (con Meet si es virtual).
import crypto from 'node:crypto'
import { DateTime } from 'luxon'
import { config, ajustes } from './config.js'
import { listarCitas, agregarCita, actualizarCita } from './almacen.js'
import { zonaHorariaDe, quienAtiende, nombreEstado } from './zonas.js'

const DIAS = ['', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
export const zonaBase = () => ajustes.zonaHoraria || 'America/Chicago'
export const ahora = (tz) => DateTime.now().setZone(tz || zonaBase())
const duracionMin = () => ajustes.duracionCitaMinutos || 40
const tope = () => ajustes.maxCitasSimultaneas || 2
const PASO_MIN = 30 // para listar horas libres

export function formatoHumano (dt) {
  return dt.setLocale('es').toFormat("cccc d 'de' LLLL, h:mm a")
}
const soloHora = (dt) => dt.setLocale('es').toFormat('h:mm a')

/** En qué zona horaria se mide el horario y quién atiende, según zona y modalidad */
export function reglas (zona, modalidad) {
  if (modalidad === 'meet') return { tz: zonaBase(), atiende: ajustes.atiendeMeet || 'Tomás' }
  return { tz: zona ? zonaHorariaDe(zona) : zonaBase(), atiende: quienAtiende(zona) }
}

/** Ventana del día: [primera hora, última hora de inicio] en la zona horaria dada */
function ventana (dia) {
  const h = ajustes.horarioAtencion?.[DIAS[dia.weekday]]
  if (!Array.isArray(h) || h.length < 2) return null
  const [desde, hasta] = h.map(t => {
    const [hh, mm] = String(t).split(':').map(Number)
    return dia.startOf('day').set({ hour: hh, minute: mm || 0 })
  })
  return { desde, hasta }
}

/** Cuántas citas de esta persona coinciden a la vez en algún momento del intervalo */
function maxSimultaneas (inicio, fin, atiende, excluirId) {
  const lista = listarCitas().filter(c =>
    c.estado === 'agendada' && (c.atiende || 'Tomás') === atiende && c.id !== excluirId &&
    Date.parse(c.inicio) < +fin && Date.parse(c.fin) > +inicio)
  const puntos = [+inicio, ...lista.map(c => Date.parse(c.inicio)).filter(t => t > +inicio && t < +fin)]
  return Math.max(0, ...puntos.map(t => lista.filter(c => Date.parse(c.inicio) <= t && Date.parse(c.fin) > t).length))
}

/**
 * ¿Se puede agendar a esta hora?
 * @param {DateTime} inicio
 * @returns {{ok: boolean, motivo?: string}}
 */
export function validarHora (inicio, zona, modalidad, excluirId) {
  const { tz, atiende } = reglas(zona, modalidad)
  const local = inicio.setZone(tz)
  const v = ventana(local)
  if (!v) return { ok: false, motivo: 'Ese día no hay citas.' }
  if (local < v.desde || local > v.hasta) return { ok: false, motivo: 'Fuera del horario de atención de ese día.' }
  if (local < ahora(tz).plus({ hours: ajustes.anticipacionMinimaHoras ?? 3 })) return { ok: false, motivo: 'Es muy pronto: se necesitan al menos ' + (ajustes.anticipacionMinimaHoras ?? 3) + ' horas de anticipación.' }
  if (local > ahora(tz).plus({ days: ajustes.diasAMostrar || 7 }).endOf('day')) return { ok: false, motivo: 'Solo se agenda hasta ' + (ajustes.diasAMostrar || 7) + ' días adelante.' }
  if (maxSimultaneas(local, local.plus({ minutes: duracionMin() }), atiende, excluirId) >= tope()) {
    return { ok: false, motivo: `Ya hay ${tope()} citas en ese horario.` }
  }
  return { ok: true }
}

/** Horas libres (cada 30 min) de un día del cliente */
function libresDelDia (fechaCliente, tzCliente, zona, modalidad) {
  const dia = DateTime.fromISO(fechaCliente, { zone: tzCliente }).startOf('day')
  if (!dia.isValid) return []
  const libres = []
  for (let t = dia; t < dia.plus({ days: 1 }); t = t.plus({ minutes: PASO_MIN })) {
    if (validarHora(t, zona, modalidad).ok) libres.push(t)
  }
  return libres
}

/** Junta horas libres seguidas en rangos legibles: "10:00 a. m. a 2:30 p. m. y 4:00 p. m. a 8:00 p. m." */
function rangos (libres) {
  const grupos = []
  for (const t of libres) {
    const g = grupos[grupos.length - 1]
    if (g && +t - +g[1] === PASO_MIN * 60000) g[1] = t
    else grupos.push([t, t])
  }
  return grupos.map(([a, b]) => +a === +b ? soloHora(a) : `${soloHora(a)} a ${soloHora(b)}`).join(' y ')
}

/** El hueco libre más cercano a la hora sugerida del día (ajustes.horasSugeridas), o null */
function preferido (libres) {
  if (!libres.length) return null
  const d = libres[0]
  const h = ajustes.horasSugeridas?.[DIAS[d.weekday]]
  if (!h) return libres[Math.floor(libres.length / 2)]
  const [hh, mm] = String(h).split(':').map(Number)
  const meta = d.startOf('day').set({ hour: hh, minute: mm || 0 })
  return [...libres].sort((a, b) => Math.abs(a - meta) - Math.abs(b - meta))[0]
}

/** Dos horarios concretos para proponer: en dos días distintos, o dos horas separadas si es un solo día */
function sugerir ({ fecha, tz, zona, modalidad }) {
  const fmt = (t) => ({ inicio: t.toISO(), texto: formatoHumano(t) })
  if (fecha) {
    const libres = libresDelDia(fecha, tz, zona, modalidad)
    const a = preferido(libres)
    if (!a) return []
    const b = [...libres].filter(t => Math.abs(t - a) >= 2 * 3600_000)
      .sort((x, y) => Math.abs(x - a) - Math.abs(y - a))[0] || libres.find(t => +t !== +a)
    return [a, b].filter(Boolean).sort((x, y) => x - y).map(fmt)
  }
  const hoy = ahora(tz)
  const elegidas = []
  for (let i = 0; i <= (ajustes.diasAMostrar || 7) && elegidas.length < 2; i++) {
    const t = preferido(libresDelDia(hoy.plus({ days: i }).toISODate(), tz, zona, modalidad))
    if (t) elegidas.push(t)
  }
  return elegidas.map(fmt)
}

/**
 * Consulta disponibilidad, siempre respondiendo en la hora local del cliente.
 * - con fecha y hora: si esa hora está libre o las alternativas más cercanas
 * - solo fecha: los rangos libres de ese día
 * - sin fecha: resumen de los próximos días
 */
export function consultarDisponibilidad ({ fecha, hora, zona, modalidad, tzCliente }) {
  const tz = tzCliente || zonaBase()
  if (fecha && hora) {
    const pedido = DateTime.fromISO(`${fecha}T${hora}`, { zone: tz })
    if (!pedido.isValid) return { error: 'Fecha u hora inválida. Usa fecha YYYY-MM-DD y hora HH:MM (24 h).' }
    const v = validarHora(pedido, zona, modalidad)
    if (v.ok) return { disponible: true, inicio: pedido.toISO(), texto: formatoHumano(pedido) }
    const cerca = [...libresDelDia(fecha, tz, zona, modalidad), ...libresDelDia(pedido.plus({ days: 1 }).toISODate(), tz, zona, modalidad)]
      .sort((a, b) => Math.abs(a - pedido) - Math.abs(b - pedido)).slice(0, 3).sort((a, b) => a - b)
    return {
      disponible: false,
      motivo: v.motivo,
      alternativas: cerca.map(t => ({ inicio: t.toISO(), texto: formatoHumano(t) }))
    }
  }
  if (fecha) {
    const libres = libresDelDia(fecha, tz, zona, modalidad)
    const dia = DateTime.fromISO(fecha, { zone: tz }).setLocale('es').toFormat("cccc d 'de' LLLL")
    return libres.length
      ? { fecha, dia, libre: rangos(libres), sugerencias: sugerir({ fecha, tz, zona, modalidad }), nota: 'Propónle las dos sugerencias (inicio exacto). Si no le sirven, pregúntale qué hora prefiere dentro de esos rangos y consulta con fecha y hora.' }
      : { fecha, dia, libre: '', nota: 'Ese día no hay horarios libres.' }
  }
  const hoy = ahora(tz)
  const dias = []
  for (let i = 0; i <= (ajustes.diasAMostrar || 7); i++) {
    const f = hoy.plus({ days: i }).toISODate()
    const libres = libresDelDia(f, tz, zona, modalidad)
    if (libres.length) dias.push({ fecha: f, dia: hoy.plus({ days: i }).setLocale('es').toFormat("cccc d 'de' LLLL"), libre: rangos(libres) })
  }
  return {
    sugerencias: sugerir({ tz, zona, modalidad }),
    proximosDias: dias,
    nota: 'Horas en la hora local del cliente. Propónle las dos sugerencias en una sola pregunta ("¿te queda mejor X o Y?"). Para agendar una sugerencia, usa su "inicio" exacto.'
  }
}

/** Fecha de una cita en la hora local del cliente, con la hora de Texas si es distinta */
export function formatoCita (cita) {
  const tz = cita.tzCliente || cita.zonaHoraria || zonaBase()
  const dt = DateTime.fromISO(cita.inicio).setZone(tz)
  return formatoHumano(dt) + (tz !== zonaBase() ? ` (hora local; ${soloHora(dt.setZone(zonaBase()))} en Texas)` : '')
}

// ---------- Google Calendar (Apps Script) ----------

async function llamarApps (cuerpo) {
  const r = await fetch(config.calendarioUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ clave: config.calendarioClave, ...cuerpo }),
    redirect: 'follow'
  })
  const texto = await r.text()
  let json
  try { json = JSON.parse(texto) } catch { throw new Error('El Apps Script no respondió JSON: ' + texto.slice(0, 200)) }
  if (!json.ok) throw new Error('Apps Script: ' + (json.error || 'error desconocido'))
  return json
}

/** Etiqueta del estado para el título del evento: TEXAS, GEORGIA, FLORIDA… */
function etiquetaEstado (zona, estadoUS) {
  return (zona?.nombre || nombreEstado(estadoUS) || 'Sin estado').toUpperCase()
}

/** Correos invitados: los de siempre (Angy) + los de la zona (Carlos en Georgia), sin repetir */
export function invitadosDe (zona) {
  return [...new Set([...(ajustes.calendario?.invitados || []), ...(zona?.invitados || [])].map(c => String(c).trim().toLowerCase()).filter(c => c.includes('@')))]
}

/** Crea la cita (revalida el cupo). Si hay Apps Script, la pone en Google Calendar (con Meet si es virtual). */
export async function crearCita ({ chatId, telefono, nombre, inicioISO, direccion, ciudad, notas, zona, estadoUS, modalidad = 'presencial', tzCliente = '', excluirId = null, codigoPostal = '', extraDescripcion = '' }) {
  const esMeet = modalidad === 'meet'
  const inicio = DateTime.fromISO(inicioISO, { setZone: true })
  if (!inicio.isValid) throw new Error('Fecha y hora inválidas')
  const v = validarHora(inicio, zona, modalidad, excluirId)
  if (!v.ok) return { ok: false, motivo: v.motivo + ' Consulta otra hora.' }
  const fin = inicio.plus({ minutes: duracionMin() })
  const { tz, atiende } = reglas(zona, modalidad)

  const titulo = `${etiquetaEstado(zona, estadoUS)} · ${esMeet ? 'Meet' : 'Presencial'} · ${nombre}`
  const descripcion = [
    `Cliente: ${nombre}`,
    telefono ? `WhatsApp: +${telefono}  (https://wa.me/${telefono})` : '',
    esMeet ? 'Modalidad: Google Meet' : `Modalidad: presencial\nDirección: ${direccion}`,
    ciudad ? `Ciudad: ${ciudad}${estadoUS ? ', ' + nombreEstado(estadoUS) : ''}` : '',
    `Atiende: ${atiende}`,
    notas ? `Notas: ${notas}` : '',
    extraDescripcion,
    '',
    'Agendada por Sofía (Royal Cita IA).'
  ].filter(Boolean).join('\n')

  // la cita se guarda YA (aparta el cupo) y después se crea en Google Calendar,
  // así dos chats al mismo tiempo no pueden pasarse del tope de citas simultáneas
  const cita = {
    id: 'c' + Date.now() + crypto.randomUUID().slice(0, 8),
    chatId, telefono, nombre, ciudad, notas,
    direccion: esMeet ? '' : direccion,
    modalidad: esMeet ? 'meet' : 'presencial',
    meetEnlace: esMeet ? (config.meetEnlace || '') : '',
    inicio: inicio.toISO(), fin: fin.toISO(),
    zona: zona?.id || '', zonaNombre: zona?.nombre || '', zonaHoraria: tz, tzCliente: tzCliente || tz,
    estadoUS: estadoUS || '', codigoPostal: codigoPostal || '', atiende,
    eventoId: null, estado: 'agendada', creada: Date.now(),
    recordatorio: null, confirmacion: null
  }
  agregarCita(cita)

  let errorCalendario = ''
  if (config.calendarioUrl) {
    try {
      const r = await llamarApps({
        accion: 'crear',
        titulo,
        inicio: inicio.toISO(),
        fin: fin.toISO(),
        descripcion,
        ubicacion: esMeet ? '' : direccion,
        meet: esMeet,
        colorId: ajustes.calendario?.colorId || '7',
        invitados: invitadosDe(zona)
      })
      actualizarCita(cita.id, { eventoId: r.id || null, ...(esMeet && r.meet ? { meetEnlace: r.meet } : {}) })
    } catch (e) {
      errorCalendario = e.message
      console.error('No pude crear el evento en Google Calendar:', e.message)
    }
  }
  return { ok: true, cita, errorCalendario }
}

/** Cancela una cita (y la marca como cancelada en Google Calendar) */
export async function cancelarCita (id, motivo = '') {
  const c = actualizarCita(id, { estado: 'cancelada', cancelada: Date.now(), motivoCancelacion: motivo })
  if (c?.eventoId && config.calendarioUrl) {
    try { await llamarApps({ accion: 'cancelar', id: c.eventoId }) } catch (e) { console.error('No pude cancelar en Google Calendar:', e.message) }
  }
  return c
}

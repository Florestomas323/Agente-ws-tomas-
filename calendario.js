// Horarios disponibles y creación de citas, por zona.
// Cada zona usa su hora local y sus horarios. Si hay Apps Script (CALENDARIO_URL, o el de la zona),
// lee el Google Calendar real de quien atiende y crea el evento ahí.
import { DateTime } from 'luxon'
import { config, ajustes } from './config.js'
import { listarCitas, agregarCita } from './almacen.js'
import { zonaHorariaDe, horariosDe, quienAtiende } from './zonas.js'

const DIAS = ['', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
const zonaBase = () => ajustes.zonaHoraria || 'America/Chicago'

/** Hora actual en la zona horaria de una zona (o la general) */
export const ahora = (zona) => DateTime.now().setZone(zona ? zonaHorariaDe(zona) : zonaBase())

function calendarioDe (zona) {
  const url = (zona?.calendarioUrlVariable && process.env[zona.calendarioUrlVariable]) || config.calendarioUrl
  const clave = (zona?.calendarioClaveVariable && process.env[zona.calendarioClaveVariable]) || config.calendarioClave
  return { url, clave }
}

async function llamarApps (cal, cuerpo) {
  const r = await fetch(cal.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ clave: cal.clave, ...cuerpo }),
    redirect: 'follow'
  })
  const texto = await r.text()
  let json
  try { json = JSON.parse(texto) } catch { throw new Error('El Apps Script no respondió JSON: ' + texto.slice(0, 200)) }
  if (!json.ok) throw new Error('Apps Script: ' + (json.error || 'error desconocido'))
  return json
}

/** Intervalos ocupados de quien atiende la zona */
async function ocupados (desde, hasta, zona) {
  const atiende = quienAtiende(zona)
  const lista = listarCitas()
    .filter(c => c.estado !== 'cancelada' && (c.atiende || 'Tomás') === atiende)
    .map(c => ({ inicio: DateTime.fromISO(c.inicio), fin: DateTime.fromISO(c.fin) }))

  const cal = calendarioDe(zona)
  if (cal.url) {
    const r = await llamarApps(cal, { accion: 'ocupado', desde: desde.toISO(), hasta: hasta.toISO() })
    for (const e of r.eventos) lista.push({ inicio: DateTime.fromISO(e.inicio), fin: DateTime.fromISO(e.fin) })
  }
  return lista
}

function chocan (inicio, fin, ocupadosLista, modalidad) {
  // presencial: tiempo para manejar; Zoom: solo un respiro entre citas
  const margen = { minutes: modalidad === 'zoom' ? (ajustes.margenZoomMinutos ?? 10) : (ajustes.margenTrasladoMinutos || 0) }
  const a = inicio.minus(margen)
  const b = fin.plus(margen)
  return ocupadosLista.some(o => o.inicio < b && o.fin > a)
}

/** Horarios candidatos según los horarios de la zona, entre desde y hasta (en hora local de la zona) */
function candidatos (desde, hasta, zona) {
  const horarios = horariosDe(zona)
  const lista = []
  let dia = desde.startOf('day')
  while (dia <= hasta) {
    for (const h of horarios[DIAS[dia.weekday]] || []) {
      const [hh, mm] = h.split(':').map(Number)
      lista.push(dia.set({ hour: hh, minute: mm || 0, second: 0, millisecond: 0 }))
    }
    dia = dia.plus({ days: 1 })
  }
  return lista
}

/**
 * Horarios libres en la hora local de la zona.
 * @param {string} [fecha] YYYY-MM-DD para un día concreto; si no, los próximos días.
 * @param {object} [zona]
 */
export async function horariosDisponibles (fecha, zona, modalidad = 'presencial') {
  const tz = zona ? zonaHorariaDe(zona) : zonaBase()
  const minimo = ahora(zona).plus({ hours: ajustes.anticipacionMinimaHoras ?? 3 })
  let desde, hasta
  if (fecha) {
    desde = DateTime.fromISO(fecha, { zone: tz }).startOf('day')
    if (!desde.isValid) throw new Error('Fecha inválida, usa YYYY-MM-DD')
    hasta = desde.endOf('day')
  } else {
    desde = ahora(zona).startOf('day')
    hasta = desde.plus({ days: (ajustes.diasAMostrar || 7) - 1 }).endOf('day')
  }
  const duracion = { minutes: ajustes.duracionCitaMinutos || 120 }
  const ocup = await ocupados(desde.minus({ hours: 4 }), hasta.plus({ hours: 4 }), zona)
  return candidatos(desde, hasta, zona)
    .filter(i => i >= minimo)
    .filter(i => !chocan(i, i.plus(duracion), ocup, modalidad))
}

export function formatoHumano (dt) {
  return dt.setLocale('es').toFormat("cccc d 'de' LLLL, h:mm a")
}

/** Fecha de una cita en la hora local de su zona, con aviso si no es hora de Texas */
export function formatoCita (cita) {
  const tz = cita.tzCliente || cita.zonaHoraria || zonaBase()
  const dt = DateTime.fromISO(cita.inicio).setZone(tz)
  const otra = tz !== zonaBase()
  return formatoHumano(dt) + (otra ? ` (hora local; ${formatoHumano(dt.setZone(zonaBase())).split(', ')[1]} en Texas)` : '')
}

/** Crea la cita (revalida que el horario siga libre) */
export async function crearCita ({ chatId, telefono, nombre, inicioISO, direccion, ciudad, notas, zona, modalidad = 'presencial', tzCliente = '' }) {
  const esZoom = modalidad === 'zoom'
  const tz = zona ? zonaHorariaDe(zona) : zonaBase()
  const inicio = DateTime.fromISO(inicioISO, { setZone: true }).setZone(tz)
  if (!inicio.isValid) throw new Error('Fecha y hora inválidas')
  const libres = await horariosDisponibles(inicio.toISODate(), zona, modalidad)
  if (!libres.some(l => +l === +inicio)) {
    return { ok: false, motivo: 'Ese horario ya no está disponible. Consulta de nuevo los horarios.' }
  }
  const fin = inicio.plus({ minutes: ajustes.duracionCitaMinutos || 120 })
  const titulo = (esZoom ? '🎥 Zoom · ' : '') + (ajustes.calendario?.tituloCita || 'Cita — {nombre}').replace('{nombre}', nombre) +
    (zona && zona.nombre ? ` (${zona.nombre})` : '')
  const descripcion = [
    `Cliente: ${nombre}`,
    telefono ? `WhatsApp: +${telefono}  (https://wa.me/${telefono})` : '',
    esZoom ? `Modalidad: Zoom${config.zoomEnlace ? ' — ' + config.zoomEnlace : ' (enviar el enlace al cliente)'}` : 'Modalidad: presencial',
    !esZoom ? `Dirección: ${direccion}` : '',
    ciudad ? `Ciudad: ${ciudad}` : '',
    zona ? `Zona: ${zona.nombre || zona.id} — atiende ${quienAtiende(zona)}` : '',
    notas ? `Notas: ${notas}` : '',
    '',
    'Agendada automáticamente por el asistente de WhatsApp.'
  ].filter(Boolean).join('\n')

  let eventoId = null
  const cal = calendarioDe(zona)
  if (cal.url) {
    const r = await llamarApps(cal, {
      accion: 'crear',
      titulo,
      inicio: inicio.toISO(),
      fin: fin.toISO(),
      descripcion,
      ubicacion: esZoom ? (config.zoomEnlace || 'Zoom') : direccion,
      colorId: ajustes.calendario?.colorId || '7',
      invitados: ajustes.calendario?.invitados || []
    })
    eventoId = r.id
  }

  const cita = {
    id: 'c' + Date.now(),
    chatId, telefono, nombre, direccion: esZoom ? '' : direccion, ciudad, notas, modalidad: esZoom ? 'zoom' : 'presencial',
    tzCliente: tzCliente || '', zoomEnlace: esZoom ? config.zoomEnlace : '',
    inicio: inicio.toISO(), fin: fin.toISO(),
    zona: zona?.id || '', zonaNombre: zona?.nombre || '', zonaHoraria: tz, atiende: quienAtiende(zona),
    eventoId, estado: 'agendada', creada: Date.now()
  }
  agregarCita(cita)
  return { ok: true, cita, inicioTexto: formatoHumano(inicio) }
}

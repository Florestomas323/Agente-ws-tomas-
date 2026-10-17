// Horarios disponibles y creación de citas.
// Si hay CALENDARIO_URL (Apps Script), lee tu Google Calendar real y crea el evento ahí.
// Si no, usa solo las citas que el propio bot ha agendado.
import { DateTime } from 'luxon'
import { config, ajustes } from './config.js'
import { listarCitas, agregarCita } from './almacen.js'

const DIAS = ['', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
const zona = () => ajustes.zonaHoraria || 'America/Chicago'

export const ahora = () => DateTime.now().setZone(zona())

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

/** Intervalos ocupados [{inicio: DateTime, fin: DateTime}] entre dos fechas */
async function ocupados (desde, hasta) {
  const lista = listarCitas()
    .filter(c => c.estado !== 'cancelada')
    .map(c => ({ inicio: DateTime.fromISO(c.inicio, { zone: zona() }), fin: DateTime.fromISO(c.fin, { zone: zona() }) }))

  if (config.calendarioUrl) {
    const r = await llamarApps({ accion: 'ocupado', desde: desde.toISO(), hasta: hasta.toISO() })
    for (const e of r.eventos) {
      lista.push({ inicio: DateTime.fromISO(e.inicio).setZone(zona()), fin: DateTime.fromISO(e.fin).setZone(zona()) })
    }
  }
  return lista
}

function chocan (inicio, fin, ocupadosLista) {
  const margen = { minutes: ajustes.margenTrasladoMinutos || 0 }
  const a = inicio.minus(margen)
  const b = fin.plus(margen)
  return ocupadosLista.some(o => o.inicio < b && o.fin > a)
}

/** Todos los horarios candidatos según ajustes.json, entre desde y hasta */
function candidatos (desde, hasta) {
  const lista = []
  let dia = desde.startOf('day')
  while (dia <= hasta) {
    const horas = ajustes.horarios?.[DIAS[dia.weekday]] || []
    for (const h of horas) {
      const [hh, mm] = h.split(':').map(Number)
      const inicio = dia.set({ hour: hh, minute: mm || 0, second: 0, millisecond: 0 })
      lista.push(inicio)
    }
    dia = dia.plus({ days: 1 })
  }
  return lista
}

/**
 * Devuelve horarios libres.
 * @param {string} [fecha] YYYY-MM-DD para un día concreto; si no, los próximos días.
 */
export async function horariosDisponibles (fecha) {
  const minimo = ahora().plus({ hours: ajustes.anticipacionMinimaHoras ?? 3 })
  let desde, hasta
  if (fecha) {
    desde = DateTime.fromISO(fecha, { zone: zona() }).startOf('day')
    if (!desde.isValid) throw new Error('Fecha inválida, usa YYYY-MM-DD')
    hasta = desde.endOf('day')
  } else {
    desde = ahora().startOf('day')
    hasta = desde.plus({ days: (ajustes.diasAMostrar || 7) - 1 }).endOf('day')
  }
  const duracion = { minutes: ajustes.duracionCitaMinutos || 120 }
  const ocup = await ocupados(desde.minus({ hours: 4 }), hasta.plus({ hours: 4 }))
  return candidatos(desde, hasta)
    .filter(i => i >= minimo)
    .filter(i => !chocan(i, i.plus(duracion), ocup))
}

export function formatoHumano (dt) {
  return dt.setLocale('es').toFormat("cccc d 'de' LLLL, h:mm a")
}

/** Crea la cita (revalida que el horario siga libre) */
export async function crearCita ({ chatId, telefono, nombre, inicioISO, direccion, ciudad, notas }) {
  const inicio = DateTime.fromISO(inicioISO, { zone: zona() })
  if (!inicio.isValid) throw new Error('Fecha y hora inválidas')
  const libres = await horariosDisponibles(inicio.toISODate())
  if (!libres.some(l => +l === +inicio)) {
    return { ok: false, motivo: 'Ese horario ya no está disponible. Consulta de nuevo los horarios.' }
  }
  const fin = inicio.plus({ minutes: ajustes.duracionCitaMinutos || 120 })
  const titulo = (ajustes.calendario?.tituloCita || 'Cita — {nombre}').replace('{nombre}', nombre)
  const descripcion = [
    `Cliente: ${nombre}`,
    telefono ? `WhatsApp: +${telefono}  (https://wa.me/${telefono})` : '',
    `Dirección: ${direccion}`,
    ciudad ? `Ciudad: ${ciudad}` : '',
    notas ? `Notas: ${notas}` : '',
    '',
    'Agendada automáticamente por el asistente de WhatsApp.'
  ].filter(Boolean).join('\n')

  let eventoId = null
  if (config.calendarioUrl) {
    const r = await llamarApps({
      accion: 'crear',
      titulo,
      inicio: inicio.toISO(),
      fin: fin.toISO(),
      descripcion,
      ubicacion: direccion,
      colorId: ajustes.calendario?.colorId || '7',
      invitados: ajustes.calendario?.invitados || []
    })
    eventoId = r.id
  }

  const cita = {
    id: 'c' + Date.now(),
    chatId, telefono, nombre, direccion, ciudad, notas,
    inicio: inicio.toISO(), fin: fin.toISO(),
    eventoId, estado: 'agendada', creada: Date.now()
  }
  agregarCita(cita)
  return { ok: true, cita, inicioTexto: formatoHumano(inicio) }
}

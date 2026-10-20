// El "cerebro" de Sofía: manda la conversación a Claude con herramientas para ubicar al cliente,
// consultar disponibilidad, agendar, confirmar o cancelar citas y pasar a Tomás.
import Anthropic from '@anthropic-ai/sdk'
import { DateTime } from 'luxon'
import { config, cargarInstrucciones } from './config.js'
import { consultarDisponibilidad, crearCita, cancelarCita, formatoHumano, formatoCita } from './calendario.js'
import { obtenerChat, crearOActualizarChat, listarCitas, actualizarCita } from './almacen.js'
import {
  hayZonas, zonaPorId, zonaDesdeUbicacion, zonasParaIA, codigoEstado, nombreEstado, quienAtiende, zonaHorariaDe, zonaHorariaEstado
} from './zonas.js'

let clienteIA = null
export function usarClienteIA (c) { clienteIA = c } // para pruebas
function ia () {
  if (!clienteIA) clienteIA = new Anthropic({ apiKey: config.anthropicKey })
  return clienteIA
}

const MODALIDAD = { type: 'string', enum: ['presencial', 'meet'], description: 'presencial (en su casa, primera opción) o meet (Google Meet, segunda opción)' }

const HERRAMIENTAS = [
  {
    name: 'guardar_ubicacion',
    description: 'Guarda en qué ciudad y estado vive el cliente y lo asigna a su zona. Úsala apenas sepas su ciudad, antes de consultar horarios. Si después dice otra ciudad, úsala de nuevo.',
    input_schema: {
      type: 'object',
      properties: {
        ciudad: { type: 'string', description: 'Ciudad donde vive el cliente' },
        estado: { type: 'string', description: 'Estado de EE. UU. en código de 2 letras (TX, GA, FL…). Dedúcelo de la ciudad si no lo dice.' },
        zona: { type: 'string', description: 'id de la zona de la lista que le corresponde, o "ninguna"' }
      },
      required: ['ciudad', 'estado']
    }
  },
  {
    name: 'consultar_disponibilidad',
    description: 'Consulta si hay cupo, en la hora local del cliente. Con fecha y hora: dice si esa hora está libre (y si no, las más cercanas). Solo con fecha: los rangos libres de ese día. Sin nada: los próximos días.',
    input_schema: {
      type: 'object',
      properties: {
        modalidad: MODALIDAD,
        fecha: { type: 'string', description: 'Día en hora local del cliente, formato YYYY-MM-DD (opcional)' },
        hora: { type: 'string', description: 'Hora que pidió el cliente, en su hora local, formato HH:MM de 24 horas (opcional)' }
      },
      required: ['modalidad']
    }
  },
  {
    name: 'agendar_cita',
    description: 'Agenda la cita cuando la hora está confirmada como disponible y tienes el nombre (y la dirección completa si es presencial).',
    input_schema: {
      type: 'object',
      properties: {
        modalidad: MODALIDAD,
        nombre: { type: 'string', description: 'Nombre del cliente' },
        inicio: { type: 'string', description: 'Copiado EXACTO del campo "inicio" que devolvió consultar_disponibilidad' },
        direccion: { type: 'string', description: 'Solo presencial: dirección completa (calle, número, ciudad, código postal)' },
        ciudad: { type: 'string' },
        notas: { type: 'string', description: 'Datos útiles para quien atiende: si estará la pareja, intereses, dudas, etc.' }
      },
      required: ['modalidad', 'nombre', 'inicio']
    }
  },
  {
    name: 'confirmar_cita',
    description: 'Úsala cuando el cliente confirma que sí asistirá a su cita (por ejemplo, al responder el recordatorio).',
    input_schema: { type: 'object', properties: { nota: { type: 'string' } } }
  },
  {
    name: 'cancelar_cita',
    description: 'Cancela la cita que tiene el cliente. Úsala si dice que no podrá ir o si quiere cambiarla de día/hora (después agenda la nueva).',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Lo que dijo el cliente' },
        quiere_otra_fecha: { type: 'boolean', description: 'true si quiere reagendar' }
      },
      required: ['motivo']
    }
  },
  {
    name: 'pasar_a_humano',
    description: 'Avisa a Tomás para que él continúe la conversación personalmente. Después de usarla, Sofía deja de contestar en este chat.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Por qué necesita a Tomás' },
        resumen: { type: 'string', description: 'Resumen corto de la conversación y datos del cliente' }
      },
      required: ['motivo', 'resumen']
    }
  }
]

/** Hora local del cliente: la de su zona, o la de su estado, o la de Texas */
export function tzDelCliente (chat) {
  const zona = zonaPorId(chat.zona)
  return (zona && zonaHorariaDe(zona)) || zonaHorariaEstado(chat.estadoUS) || zonaHorariaDe(null)
}

const citasVigentes = (chatId) => listarCitas().filter(c => c.chatId === chatId && c.estado === 'agendada' && Date.parse(c.fin) > Date.now())

function sistema (chat) {
  const zona = zonaPorId(chat.zona)
  const citas = citasVigentes(chat.id)
  const listado = zonasParaIA()
  const describir = (c) => `${formatoCita(c)} — ${c.modalidad === 'meet' ? 'por Google Meet' : 'presencial en ' + c.direccion}` +
    (c.confirmacion === 'confirmada' ? ' (ya confirmada)' : c.recordatorio ? ' (le enviaste el recordatorio; espera su confirmación)' : '')
  const contexto = [
    `Fecha y hora actual: ${formatoHumano(DateTime.now().setZone(tzDelCliente(chat)))} (hora local del cliente${chat.estadoUS || zona ? '' : ', supuesta de Texas'}).`,
    chat.nombre ? `Nombre de perfil de WhatsApp del cliente: ${chat.nombre} (confírmalo, puede no ser su nombre real).` : '',
    chat.origen === 'anuncio' ? 'Este cliente llegó desde un anuncio de Facebook/Instagram.' : '',
    chat.anuncio ? `Anuncio: ${chat.anuncio}` : '',
    chat.ciudad ? `Ubicación guardada: ${chat.ciudad}${chat.estadoUS ? ', ' + nombreEstado(chat.estadoUS) : ''}.` : 'Todavía no sabes dónde vive: pregúntale su ciudad.',
    zona && chat.ciudad ? `Zona: ${zona.nombre || zona.id}. La cita presencial la atiende ${quienAtiende(zona)}${quienAtiende(zona) !== 'Tomás' ? ' (asesor del equipo de Tomás)' : ''}; por Meet la atiende Tomás.` : '',
    zona && !chat.ciudad ? `Por el anuncio, parece de ${zona.nombre || zona.id}. Confirma su ciudad con guardar_ubicacion antes de consultar horarios.` : '',
    !zona && chat.ciudad && hayZonas() ? 'Vive fuera de las zonas presenciales: la cita solo puede ser por Google Meet con Tomás.' : '',
    citas.length ? `Este cliente YA tiene cita: ${citas.map(describir).join('; ')}.` : 'Este cliente todavía no tiene cita.'
  ].filter(Boolean).join('\n')

  const bloqueZonas = listado
    ? `\n\n## Zonas donde hacemos citas presenciales\n${listado}\nCuando el cliente te diga dónde vive, usa guardar_ubicacion con su zona. Si no está en ninguna, usa "ninguna" y ofrécele la cita por Google Meet.`
    : ''
  return cargarInstrucciones() + bloqueZonas + '\n\n## Contexto de esta conversación\n' + contexto
}

/** Convierte el historial guardado en mensajes para Claude (une mensajes seguidos del mismo rol) */
function aMensajes (historial) {
  const msgs = []
  for (const h of historial) {
    const role = h.rol === 'cliente' ? 'user' : 'assistant'
    const texto = h.rol === 'tomas' ? `[Tomás escribió personalmente]: ${h.texto}` : h.texto
    const ultimo = msgs[msgs.length - 1]
    if (ultimo && ultimo.role === role) ultimo.content += '\n' + texto
    else msgs.push({ role, content: texto })
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift()
  return msgs
}

/**
 * Genera la respuesta para un chat.
 * @returns {{texto, cita?, humano?, ubicacion?, confirmada?, cancelada?}}
 */
export async function responder (chatId) {
  const chat = obtenerChat(chatId)
  const mensajes = aMensajes(chat.historial)
  if (!mensajes.length) return { texto: '' }

  const resultado = { texto: '' }
  for (let vuelta = 0; vuelta < 6; vuelta++) {
    const r = await ia().messages.create({
      model: config.modelo,
      max_tokens: 700,
      system: sistema(obtenerChat(chatId)),
      tools: HERRAMIENTAS,
      messages: mensajes
    })
    const textos = r.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
    const usos = r.content.filter(b => b.type === 'tool_use')
    if (r.stop_reason !== 'tool_use' || !usos.length) {
      resultado.texto = textos
      return resultado
    }
    mensajes.push({ role: 'assistant', content: r.content })
    const respuestas = []
    for (const uso of usos) {
      let salida
      try {
        salida = await ejecutar(uso.name, uso.input || {}, obtenerChat(chatId), resultado)
      } catch (e) {
        console.error('Error en herramienta', uso.name, e)
        salida = { error: 'No se pudo completar: ' + e.message }
      }
      respuestas.push({ type: 'tool_result', tool_use_id: uso.id, content: JSON.stringify(salida) })
    }
    mensajes.push({ role: 'user', content: respuestas })
  }
  return resultado
}

const modalidadDe = (m) => (m === 'meet' || m === 'zoom' || m === 'virtual') ? 'meet' : 'presencial'

async function ejecutar (nombre, entrada, chat, resultado) {
  if (nombre === 'guardar_ubicacion') {
    const ciudad = String(entrada.ciudad || '').trim().slice(0, 80)
    const estado = codigoEstado(entrada.estado)
    let zona = null
    if (hayZonas()) {
      const elegida = entrada.zona && entrada.zona !== 'ninguna' ? zonaPorId(entrada.zona) : null
      zona = elegida || zonaDesdeUbicacion(ciudad, estado)
    }
    const anterior = chat.zona || ''
    crearOActualizarChat(chat.id, { ciudad, estadoUS: estado, zona: zona?.id || '' })
    resultado.ubicacion = { zonaAnterior: anterior, zonaNueva: zona?.id || '', ciudad, estado }
    if (!hayZonas()) return { guardado: true, nota: 'Ofrece primero la cita presencial.' }
    if (!zona) return { guardado: true, presencial: false, nota: 'No hacemos citas presenciales ahí. Ofrécele la cita por Google Meet (modalidad meet).' }
    return { guardado: true, presencial: true, zona: zona.nombre || zona.id, atiendePresencial: quienAtiende(zona), nota: 'Ofrece la cita presencial y pregunta qué día y hora le queda mejor.' }
  }

  if (nombre === 'consultar_disponibilidad') {
    const zona = zonaPorId(chat.zona)
    const modalidad = modalidadDe(entrada.modalidad)
    if (hayZonas() && !chat.ciudad) return { nota: 'Primero pregunta en qué ciudad vive y usa guardar_ubicacion.' }
    if (modalidad === 'presencial' && hayZonas() && !zona) return { nota: 'No hacemos citas presenciales donde vive. Ofrécele Google Meet.' }
    return { modalidad, ...consultarDisponibilidad({ fecha: entrada.fecha, hora: entrada.hora, zona, modalidad, tzCliente: tzDelCliente(chat) }) }
  }

  if (nombre === 'agendar_cita') {
    const zona = zonaPorId(chat.zona)
    const modalidad = modalidadDe(entrada.modalidad)
    if (hayZonas() && !chat.ciudad) return { agendada: false, motivo: 'Primero confirma la ciudad del cliente con guardar_ubicacion.' }
    if (modalidad === 'presencial' && hayZonas() && !zona) return { agendada: false, motivo: 'Donde vive solo podemos hacer la cita por Google Meet.' }
    if (modalidad === 'presencial' && !String(entrada.direccion || '').trim()) return { agendada: false, motivo: 'Para la cita presencial falta la dirección completa.' }
    if (citasVigentes(chat.id).length) return { agendada: false, motivo: 'Ya tiene una cita. Si quiere cambiarla, primero usa cancelar_cita.' }
    const r = await crearCita({
      modalidad,
      tzCliente: tzDelCliente(chat),
      chatId: chat.id,
      telefono: chat.telefono,
      nombre: entrada.nombre,
      inicioISO: entrada.inicio,
      direccion: entrada.direccion,
      ciudad: entrada.ciudad || chat.ciudad,
      estadoUS: chat.estadoUS,
      notas: entrada.notas,
      zona
    })
    if (!r.ok) return { agendada: false, motivo: r.motivo }
    crearOActualizarChat(chat.id, { nombreReal: entrada.nombre })
    resultado.cita = r.cita
    resultado.errorCalendario = r.errorCalendario
    const cuando = formatoHumano(DateTime.fromISO(r.cita.inicio).setZone(tzDelCliente(chat)))
    return modalidad === 'meet'
      ? { agendada: true, modalidad: 'meet', cuando, enlaceMeet: r.cita.meetEnlace || null, nota: r.cita.meetEnlace ? 'Comparte el enlace de Google Meet con el cliente.' : 'Dile que le enviarán el enlace de Google Meet antes de la cita.' }
      : { agendada: true, modalidad: 'presencial', cuando, direccion: r.cita.direccion }
  }

  if (nombre === 'confirmar_cita') {
    const c = citasVigentes(chat.id)[0]
    if (!c) return { ok: false, nota: 'No tiene una cita próxima.' }
    actualizarCita(c.id, { confirmacion: 'confirmada', confirmadaEn: Date.now() })
    resultado.confirmada = c
    return { ok: true, cuando: formatoCita(c), nota: 'Agradécele y recuérdale el regalo premium para su cocina.' }
  }

  if (nombre === 'cancelar_cita') {
    const c = citasVigentes(chat.id)[0]
    if (!c) return { ok: false, nota: 'No tiene una cita próxima.' }
    await cancelarCita(c.id, entrada.motivo || '')
    resultado.cancelada = { ...c, motivo: entrada.motivo || '', reagendar: Boolean(entrada.quiere_otra_fecha) }
    return { ok: true, nota: entrada.quiere_otra_fecha ? 'Cita anterior cancelada. Consulta la nueva fecha y hora y agéndala.' : 'Cita cancelada. Despídete con amabilidad y déjale la puerta abierta.' }
  }

  if (nombre === 'pasar_a_humano') {
    resultado.humano = { motivo: entrada.motivo, resumen: entrada.resumen }
    return { ok: true, nota: 'Tomás fue avisado. Despídete brevemente diciendo que Tomás le escribirá pronto.' }
  }
  return { error: 'Herramienta desconocida' }
}

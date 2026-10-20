// El "cerebro": manda la conversación a Claude con herramientas para ubicar al cliente,
// ver horarios, agendar y pasar a Tomás.
import Anthropic from '@anthropic-ai/sdk'
import { DateTime } from 'luxon'
import { config, cargarInstrucciones } from './config.js'
import { horariosDisponibles, crearCita, formatoHumano, formatoCita, ahora } from './calendario.js'
import { obtenerChat, crearOActualizarChat, listarCitas } from './almacen.js'
import {
  hayZonas, zonaPorId, zonaDesdeUbicacion, zonasParaIA, codigoEstado, nombreEstado, quienAtiende, zonaHorariaDe, zonaHorariaEstado
} from './zonas.js'

let clienteIA = null
export function usarClienteIA (c) { clienteIA = c } // para pruebas
function ia () {
  if (!clienteIA) clienteIA = new Anthropic({ apiKey: config.anthropicKey })
  return clienteIA
}

const HERRAMIENTAS = [
  {
    name: 'guardar_ubicacion',
    description: 'Guarda en qué ciudad y estado vive el cliente y lo asigna a la zona que le corresponde. Úsala apenas sepas su ciudad, antes de ofrecer horarios. Si después dice otra ciudad, úsala de nuevo.',
    input_schema: {
      type: 'object',
      properties: {
        ciudad: { type: 'string', description: 'Ciudad donde vive el cliente' },
        estado: { type: 'string', description: 'Estado de EE. UU. en código de 2 letras (TX, FL, CA…). Dedúcelo de la ciudad si el cliente no lo dice.' },
        zona: { type: 'string', description: 'id de la zona de la lista que le corresponde por cercanía, o "ninguna" si no está cerca de ninguna' }
      },
      required: ['ciudad', 'estado']
    }
  },
  {
    name: 'ver_horarios_disponibles',
    description: 'Devuelve los horarios libres para la cita, en la hora local del cliente. Úsala antes de ofrecer horarios. Sin fecha devuelve los próximos días.',
    input_schema: {
      type: 'object',
      properties: {
        modalidad: { type: 'string', enum: ['presencial', 'zoom'], description: 'presencial (en su casa, la primera opción) o zoom (videollamada, la segunda opción)' },
        fecha: { type: 'string', description: 'Día concreto en formato YYYY-MM-DD (opcional)' }
      },
      required: ['modalidad']
    }
  },
  {
    name: 'agendar_cita',
    description: 'Agenda la cita cuando el cliente ya eligió un horario de la lista y dio su nombre (y su dirección completa si es presencial).',
    input_schema: {
      type: 'object',
      properties: {
        modalidad: { type: 'string', enum: ['presencial', 'zoom'], description: 'La misma modalidad con la que consultaste los horarios' },
        nombre: { type: 'string', description: 'Nombre del cliente' },
        inicio: { type: 'string', description: 'Horario elegido, copiado EXACTO del campo "inicio" de ver_horarios_disponibles' },
        direccion: { type: 'string', description: 'Solo presencial: dirección completa (calle, número, ciudad, código postal)' },
        ciudad: { type: 'string' },
        notas: { type: 'string', description: 'Datos útiles para quien atiende: si estará la pareja, intereses, dudas, etc.' }
      },
      required: ['modalidad', 'nombre', 'inicio']
    }
  },
  {
    name: 'pasar_a_humano',
    description: 'Avisa a Tomás para que él continúe la conversación personalmente. Después de usarla, el asistente deja de contestar en este chat.',
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

function sistema (chat) {
  const zona = zonaPorId(chat.zona)
  const citas = listarCitas().filter(c => c.chatId === chat.id && c.estado === 'agendada')
  const listado = zonasParaIA()
  const contexto = [
    `Fecha y hora actual: ${formatoHumano(DateTime.now().setZone(tzDelCliente(chat)))} (hora local del cliente${chat.estadoUS || zona ? '' : ', supuesta de Texas'}).`,
    chat.nombre ? `Nombre de perfil de WhatsApp del cliente: ${chat.nombre} (confírmalo, puede no ser su nombre real).` : '',
    chat.origen === 'anuncio' ? 'Este cliente llegó desde un anuncio de Facebook/Instagram.' : '',
    chat.anuncio ? `Anuncio: ${chat.anuncio}` : '',
    chat.ciudad ? `Ubicación guardada: ${chat.ciudad}${chat.estadoUS ? ', ' + nombreEstado(chat.estadoUS) : ''}.` : 'Todavía no sabes dónde vive: pregúntale su ciudad.',
    zona && chat.ciudad ? `Zona asignada: ${zona.nombre || zona.id} (atiende ${quienAtiende(zona)}). Los horarios que te da la herramienta ya están en la hora local del cliente.` : '',
    zona && !chat.ciudad ? `Por el anuncio, parece de la zona "${zona.nombre || zona.id}". Confirma su ciudad con guardar_ubicacion antes de ofrecer horarios.` : '',
    !zona && chat.ciudad && hayZonas() ? 'Vive fuera de las zonas presenciales: la cita solo puede ser por Zoom.' : '',
    citas.length ? `Este cliente YA tiene cita: ${citas.map(c => formatoCita(c) + ' en ' + c.direccion).join('; ')}.` : 'Este cliente todavía no tiene cita.'
  ].filter(Boolean).join('\n')

  const bloqueZonas = listado
    ? `\n\n## Zonas donde hacemos citas presenciales\n${listado}\nCuando el cliente te diga dónde vive, usa guardar_ubicacion con la zona más cercana. Si no está cerca de ninguna, usa "ninguna" y ofrécele la cita por Zoom (no presencial).`
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
 * @returns {{texto: string, cita?: object, humano?: {motivo, resumen}, ubicacion?: {zonaAnterior, zonaNueva, ciudad, estado}}}
 */
export async function responder (chatId) {
  const chat = obtenerChat(chatId)
  const mensajes = aMensajes(chat.historial)
  if (!mensajes.length) return { texto: '' }

  const resultado = { texto: '' }

  for (let vuelta = 0; vuelta < 6; vuelta++) {
    const r = await ia().messages.create({
      model: config.modelo,
      max_tokens: 600,
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

/** Hora local del cliente: la de su zona, o la de su estado, o la de Texas */
function tzDelCliente (chat) {
  const zona = zonaPorId(chat.zona)
  return (zona && zonaHorariaDe(zona)) || zonaHorariaEstado(chat.estadoUS) || zonaHorariaDe(null)
}

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
    if (!hayZonas()) return { guardado: true, nota: 'Ubicación guardada. Ofrece primero la cita presencial.' }
    if (!zona) return { guardado: true, presencial: false, nota: 'No hacemos citas presenciales en esa zona. Ofrécele la cita por Zoom (ver_horarios_disponibles con modalidad zoom).' }
    return {
      guardado: true,
      presencial: true,
      zona: zona.nombre || zona.id,
      atiende: quienAtiende(zona),
      zonaHoraria: zonaHorariaDe(zona),
      nota: 'Ya puedes ofrecer horarios con ver_horarios_disponibles.'
    }
  }

  if (nombre === 'ver_horarios_disponibles') {
    const zona = zonaPorId(chat.zona)
    const modalidad = entrada.modalidad === 'zoom' ? 'zoom' : 'presencial'
    if (hayZonas() && !chat.ciudad) return { horarios: [], nota: 'Primero pregunta en qué ciudad vive y usa guardar_ubicacion.' }
    if (modalidad === 'presencial' && hayZonas() && !zona) {
      return { horarios: [], nota: 'No hacemos citas presenciales donde vive. Ofrécele la cita por Zoom.' }
    }
    const libres = await horariosDisponibles(entrada.fecha, zona, modalidad)
    if (!libres.length) return { horarios: [], nota: 'No hay horarios libres en ese rango. Ofrece otro día o la otra modalidad.' }
    const tz = tzDelCliente(chat)
    return {
      modalidad,
      horarios: libres.slice(0, 20).map(l => ({ inicio: l.toISO(), texto: formatoHumano(l.setZone(tz)) })),
      nota: 'Horas en la hora local del cliente. Ofrece solo 2 o 3 opciones.'
    }
  }

  if (nombre === 'agendar_cita') {
    const zona = zonaPorId(chat.zona)
    const modalidad = entrada.modalidad === 'zoom' ? 'zoom' : 'presencial'
    if (hayZonas() && !chat.ciudad) return { agendada: false, motivo: 'Primero confirma la ciudad del cliente con guardar_ubicacion.' }
    if (modalidad === 'presencial' && hayZonas() && !zona) return { agendada: false, motivo: 'Donde vive solo podemos hacer la cita por Zoom.' }
    if (modalidad === 'presencial' && !String(entrada.direccion || '').trim()) return { agendada: false, motivo: 'Para la cita presencial falta la dirección completa.' }
    const r = await crearCita({
      modalidad,
      tzCliente: tzDelCliente(chat),
      chatId: chat.id,
      telefono: chat.telefono,
      nombre: entrada.nombre,
      inicioISO: entrada.inicio,
      direccion: entrada.direccion,
      ciudad: entrada.ciudad || chat.ciudad,
      notas: entrada.notas,
      zona
    })
    if (r.ok) {
      crearOActualizarChat(chat.id, { nombreReal: entrada.nombre })
      resultado.cita = r.cita
      const cuando = formatoHumano(DateTime.fromISO(r.cita.inicio).setZone(tzDelCliente(chat)))
      return modalidad === 'zoom'
        ? { agendada: true, modalidad: 'zoom', cuando, enlaceZoom: config.zoomEnlace || null, nota: config.zoomEnlace ? 'Comparte el enlace de Zoom con el cliente.' : 'Dile que le enviarán el enlace de Zoom antes de la cita.' }
        : { agendada: true, modalidad: 'presencial', cuando, direccion: r.cita.direccion }
    }
    return { agendada: false, motivo: r.motivo }
  }

  if (nombre === 'pasar_a_humano') {
    resultado.humano = { motivo: entrada.motivo, resumen: entrada.resumen }
    return { ok: true, nota: 'Tomás fue avisado. Despídete brevemente diciendo que Tomás le escribirá pronto.' }
  }
  return { error: 'Herramienta desconocida' }
}

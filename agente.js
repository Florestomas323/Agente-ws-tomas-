// El "cerebro": manda la conversación a Claude con herramientas para ubicar al cliente,
// ver horarios, agendar y pasar a Tomás.
import Anthropic from '@anthropic-ai/sdk'
import { config, cargarInstrucciones } from './config.js'
import { horariosDisponibles, crearCita, formatoHumano, formatoCita, ahora } from './calendario.js'
import { obtenerChat, crearOActualizarChat, listarCitas } from './almacen.js'
import {
  hayZonas, zonaPorId, zonaDesdeUbicacion, zonasParaIA, codigoEstado, nombreEstado, quienAtiende, zonaHorariaDe
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
    description: 'Devuelve los horarios libres para la demostración, en la hora local del cliente. Úsala antes de ofrecer horarios. Sin fecha devuelve los próximos días.',
    input_schema: {
      type: 'object',
      properties: {
        fecha: { type: 'string', description: 'Día concreto en formato YYYY-MM-DD (opcional)' }
      }
    }
  },
  {
    name: 'agendar_cita',
    description: 'Agenda la demostración cuando el cliente ya eligió un horario de la lista y dio su nombre y dirección completa.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre del cliente' },
        inicio: { type: 'string', description: 'Horario elegido, copiado EXACTO del campo "inicio" de ver_horarios_disponibles' },
        direccion: { type: 'string', description: 'Dirección completa: calle, número, ciudad, código postal' },
        ciudad: { type: 'string' },
        notas: { type: 'string', description: 'Datos útiles para quien atiende: si estará la pareja, intereses, dudas, etc.' }
      },
      required: ['nombre', 'inicio', 'direccion']
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
    `Fecha y hora actual: ${formatoHumano(ahora(zona))} (${zona ? 'hora local de la zona del cliente' : 'hora de Texas'}).`,
    chat.nombre ? `Nombre de perfil de WhatsApp del cliente: ${chat.nombre} (confírmalo, puede no ser su nombre real).` : '',
    chat.origen === 'anuncio' ? 'Este cliente llegó desde un anuncio de Facebook/Instagram.' : '',
    chat.anuncio ? `Anuncio: ${chat.anuncio}` : '',
    chat.ciudad ? `Ubicación guardada: ${chat.ciudad}${chat.estadoUS ? ', ' + nombreEstado(chat.estadoUS) : ''}.` : 'Todavía no sabes dónde vive: pregúntale su ciudad.',
    zona && chat.ciudad ? `Zona asignada: ${zona.nombre || zona.id} (atiende ${quienAtiende(zona)}). Los horarios que te da la herramienta ya están en la hora local del cliente.` : '',
    zona && !chat.ciudad ? `Por el anuncio, parece de la zona "${zona.nombre || zona.id}". Confirma su ciudad con guardar_ubicacion antes de ofrecer horarios.` : '',
    citas.length ? `Este cliente YA tiene cita: ${citas.map(c => formatoCita(c) + ' en ' + c.direccion).join('; ')}.` : 'Este cliente todavía no tiene cita.'
  ].filter(Boolean).join('\n')

  const bloqueZonas = listado
    ? `\n\n## Zonas que cubrimos\n${listado}\nCuando el cliente te diga dónde vive, usa guardar_ubicacion con la zona más cercana. Si no está cerca de ninguna, usa "ninguna": no le ofrezcas horarios, dile que vas a pasar sus datos y usa pasar_a_humano.`
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
    if (!hayZonas()) return { guardado: true, nota: 'Ubicación guardada. Revisa en tus instrucciones si cubrimos esa ciudad.' }
    if (!zona) return { guardado: true, cubrimos: false, nota: 'No cubrimos esa zona. No ofrezcas horarios: dile con amabilidad que pasarás sus datos y usa pasar_a_humano.' }
    return {
      guardado: true,
      cubrimos: true,
      zona: zona.nombre || zona.id,
      atiende: quienAtiende(zona),
      zonaHoraria: zonaHorariaDe(zona),
      nota: 'Ya puedes ofrecer horarios con ver_horarios_disponibles.'
    }
  }

  if (nombre === 'ver_horarios_disponibles') {
    const zona = zonaPorId(chat.zona)
    if (hayZonas() && (!zona || !chat.ciudad)) {
      return { horarios: [], nota: chat.ciudad ? 'Este cliente está fuera de nuestras zonas: usa pasar_a_humano.' : 'Primero pregunta en qué ciudad vive y usa guardar_ubicacion.' }
    }
    const libres = await horariosDisponibles(entrada.fecha, zona)
    if (!libres.length) return { horarios: [], nota: 'No hay horarios libres en ese rango. Ofrece otro día o pasa a Tomás.' }
    return {
      horarios: libres.slice(0, 20).map(l => ({ inicio: l.toISO(), texto: formatoHumano(l) })),
      nota: 'Horas en la hora local del cliente. Ofrece solo 2 o 3 opciones.'
    }
  }

  if (nombre === 'agendar_cita') {
    const zona = zonaPorId(chat.zona)
    if (hayZonas() && !zona) return { agendada: false, motivo: 'Primero confirma la ciudad del cliente con guardar_ubicacion.' }
    const r = await crearCita({
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
      return { agendada: true, cuando: r.inicioTexto, direccion: r.cita.direccion }
    }
    return { agendada: false, motivo: r.motivo }
  }

  if (nombre === 'pasar_a_humano') {
    resultado.humano = { motivo: entrada.motivo, resumen: entrada.resumen }
    return { ok: true, nota: 'Tomás fue avisado. Despídete brevemente diciendo que Tomás le escribirá pronto.' }
  }
  return { error: 'Herramienta desconocida' }
}

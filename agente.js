// El "cerebro": manda la conversación a Claude con herramientas para ver horarios, agendar y pasar a Tomás.
import Anthropic from '@anthropic-ai/sdk'
import { DateTime } from 'luxon'
import { config, cargarInstrucciones } from './config.js'
import { horariosDisponibles, crearCita, formatoHumano, ahora } from './calendario.js'
import { obtenerChat, listarCitas } from './almacen.js'

let clienteIA = null
export function usarClienteIA (c) { clienteIA = c } // para pruebas
function ia () {
  if (!clienteIA) clienteIA = new Anthropic({ apiKey: config.anthropicKey })
  return clienteIA
}

const HERRAMIENTAS = [
  {
    name: 'ver_horarios_disponibles',
    description: 'Devuelve los horarios libres para la demostración. Úsala antes de ofrecer horarios. Sin fecha devuelve los próximos días.',
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
        notas: { type: 'string', description: 'Datos útiles para Tomás: si estará la pareja, intereses, dudas, etc.' }
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
  const citas = listarCitas().filter(c => c.chatId === chat.id && c.estado === 'agendada')
  const contexto = [
    `Fecha y hora actual: ${formatoHumano(ahora())} (hora de Texas).`,
    chat.nombre ? `Nombre de perfil de WhatsApp del cliente: ${chat.nombre} (confírmalo, puede no ser su nombre real).` : '',
    chat.origen === 'anuncio' ? 'Este cliente llegó desde un anuncio de Facebook/Instagram.' : '',
    chat.anuncio ? `Anuncio: ${chat.anuncio}` : '',
    citas.length ? `Este cliente YA tiene cita: ${citas.map(c => formatoHumano(DateTime.fromISO(c.inicio).setZone(ahora().zone)) + ' en ' + c.direccion).join('; ')}.` : 'Este cliente todavía no tiene cita.'
  ].filter(Boolean).join('\n')
  return cargarInstrucciones() + '\n\n## Contexto de esta conversación\n' + contexto
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
 * @returns {{texto: string, cita?: object, humano?: {motivo, resumen}}}
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
      system: sistema(chat),
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
        salida = await ejecutar(uso.name, uso.input || {}, chat, resultado)
      } catch (e) {
        console.error('Error en herramienta', uso.name, e)
        salida = { error: 'No se pudo completar: ' + e.message }
      }
      respuestas.push({ type: 'tool_result', tool_use_id: uso.id, content: JSON.stringify(salida) })
    }
    mensajes.push({ role: 'user', content: respuestas })
  }
  resultado.texto = resultado.texto || ''
  return resultado
}

async function ejecutar (nombre, entrada, chat, resultado) {
  if (nombre === 'ver_horarios_disponibles') {
    const libres = await horariosDisponibles(entrada.fecha)
    if (!libres.length) return { horarios: [], nota: 'No hay horarios libres en ese rango. Ofrece otro día o pasa a Tomás.' }
    return {
      horarios: libres.slice(0, 20).map(l => ({ inicio: l.toISO(), texto: formatoHumano(l) })),
      nota: 'Ofrece solo 2 o 3 opciones al cliente.'
    }
  }
  if (nombre === 'agendar_cita') {
    const r = await crearCita({
      chatId: chat.id,
      telefono: chat.telefono,
      nombre: entrada.nombre,
      inicioISO: entrada.inicio,
      direccion: entrada.direccion,
      ciudad: entrada.ciudad,
      notas: entrada.notas
    })
    if (r.ok) {
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

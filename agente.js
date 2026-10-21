// El "cerebro" de Sofía: manda la conversación a Claude con herramientas para ubicar al cliente,
// consultar disponibilidad, agendar, reprogramar, confirmar o cancelar citas y pasar a Tomás.
import Anthropic from '@anthropic-ai/sdk'
import { DateTime } from 'luxon'
import { config, cargarInstrucciones } from './config.js'
import { consultarDisponibilidad, crearCita, cancelarCita, formatoHumano, formatoCita } from './calendario.js'
import { obtenerChat, crearOActualizarChat, listarCitas, actualizarCita } from './almacen.js'
import {
  hayZonas, zonaPorId, zonaDesdeUbicacion, zonasParaIA, codigoEstado, nombreEstado, quienAtiende, zonaHorariaDe,
  zonaHorariaEstado, estadoDesdeZip, ofertaPorId, ofertaValeEn
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
    description: 'Guarda en qué ciudad, estado y código postal vive el cliente y lo asigna a su zona. Úsala apenas sepas su ciudad (o su código postal), antes de consultar horarios. Si después dice otra ciudad, úsala de nuevo.',
    input_schema: {
      type: 'object',
      properties: {
        ciudad: { type: 'string', description: 'Ciudad donde vive el cliente' },
        estado: { type: 'string', description: 'Estado de EE. UU. en código de 2 letras (TX, GA, FL…). Dedúcelo de la ciudad si no lo dice.' },
        codigo_postal: { type: 'string', description: 'Código postal (ZIP) de 5 dígitos, si lo dio' },
        zona: { type: 'string', description: 'id de la zona de la lista que le corresponde, o "ninguna"' }
      },
      required: ['ciudad', 'estado']
    }
  },
  {
    name: 'consultar_disponibilidad',
    description: 'Consulta horarios en la hora local del cliente. Sin hora: devuelve dos "sugerencias" concretas para proponerle (y los rangos libres). Con fecha y hora: dice si esa hora está libre (y si no, las más cercanas).',
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
    name: 'acepto_demostracion',
    description: 'Registra que el cliente aceptó recibir la demostración (por ejemplo, cuando dice que sí a la condición de la promoción). No agenda nada.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'agendar_cita',
    description: 'Agenda la cita cuando la hora está confirmada como disponible y tienes el nombre (y la dirección completa si es presencial). Si ya tiene cita, usa reprogramar_cita.',
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
    name: 'reprogramar_cita',
    description: 'Cambia la cita que ya tiene el cliente a otro día u hora. Primero aparta la nueva y, solo si quedó, suelta la anterior. Consulta antes la nueva hora con consultar_disponibilidad.',
    input_schema: {
      type: 'object',
      properties: {
        inicio: { type: 'string', description: 'Copiado EXACTO del campo "inicio" de la nueva hora' },
        modalidad: { ...MODALIDAD, description: 'Solo si cambia de modalidad; si no, se mantiene la misma' },
        direccion: { type: 'string', description: 'Solo si es presencial y cambia la dirección (o pasa de Meet a presencial)' },
        motivo: { type: 'string', description: 'Lo que dijo el cliente' }
      },
      required: ['inicio']
    }
  },
  {
    name: 'confirmar_cita',
    description: 'Úsala cuando el cliente confirma que sí asistirá a su cita (por ejemplo, al responder el recordatorio).',
    input_schema: { type: 'object', properties: { nota: { type: 'string' } } }
  },
  {
    name: 'cancelar_cita',
    description: 'Cancela la cita cuando el cliente dice que no podrá ir y NO quiere otra fecha. Si quiere otra fecha, no canceles: usa reprogramar_cita.',
    input_schema: {
      type: 'object',
      properties: { motivo: { type: 'string', description: 'Lo que dijo el cliente' } },
      required: ['motivo']
    }
  },
  {
    name: 'enviar_experiencia',
    description: 'Envía el enlace de la promoción del anuncio (por ejemplo, los sombreros). Solo después de agendar la cita. El enlace sale en un mensaje aparte, justo después del tuyo.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'marcar_no_interesado',
    description: 'Úsala cuando la persona dice claramente que no le interesa o que no quiere la demostración. Así no se le vuelve a escribir.',
    input_schema: { type: 'object', properties: { motivo: { type: 'string' } }, required: ['motivo'] }
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

export const citasVigentes = (chatId) => listarCitas().filter(c => c.chatId === chatId && c.estado === 'agendada' && Date.parse(c.fin) > Date.now())

/** La oferta del anuncio, si sigue valiendo para este cliente */
export function ofertaActiva (chat) {
  const o = ofertaPorId(chat?.oferta)
  if (!o || chat.ofertaNoAplica) return null
  return ofertaValeEn(o, chat.estadoUS) ? o : null
}

/** Anota un paso del prospecto (se ve en la app y en Royal Sales IA) */
export function marcarAvance (chatId, clave, etiqueta) {
  const chat = obtenerChat(chatId)
  if (!chat) return
  crearOActualizarChat(chatId, { avance: etiqueta, hitos: { ...(chat.hitos || {}), [clave]: chat.hitos?.[clave] || Date.now() } })
}

function hace (ms) {
  const min = Math.round(ms / 60000)
  if (min < 120) return `${min} minutos`
  const h = Math.round(min / 60)
  return h < 48 ? `${h} horas` : `${Math.round(h / 24)} días`
}

function sistema (chat, { seguimiento = false } = {}) {
  const zona = zonaPorId(chat.zona)
  const citas = citasVigentes(chat.id)
  const listado = zonasParaIA()
  const oferta = ofertaActiva(chat)
  const ofertaOriginal = ofertaPorId(chat.oferta)
  const describir = (c) => `${formatoCita(c)} — ${c.modalidad === 'meet' ? 'por Google Meet' : 'presencial en ' + c.direccion}` +
    (c.confirmacion === 'confirmada' ? ' (ya confirmada)' : c.recordatorio ? ' (le enviaste el recordatorio; espera su confirmación)' : '')
  // demora: solo si el último mensaje es del cliente y nadie le contestó (no en seguimientos)
  const ultimoMsg = (chat.historial || []).at(-1)
  const demora = !seguimiento && ultimoMsg?.rol === 'cliente' ? Date.now() - ultimoMsg.t : 0
  const contexto = [
    `Fecha y hora actual: ${formatoHumano(DateTime.now().setZone(tzDelCliente(chat)))} (hora local del cliente${chat.estadoUS || zona ? '' : ', supuesta de Texas'}).`,
    demora > 60 * 60_000 ? `Su último mensaje llegó hace ${hace(demora)} y no se le había contestado: empieza disculpándote en pocas palabras por la demora.` : '',
    chat.nombre ? `Nombre de perfil de WhatsApp del cliente: ${chat.nombre} (confírmalo, puede no ser su nombre real).` : '',
    chat.nombreReal ? `Su nombre: ${chat.nombreReal}.` : '',
    chat.origen === 'anuncio' ? 'Este cliente llegó desde un anuncio de Facebook/Instagram.' : '',
    chat.anuncio ? `Anuncio: ${chat.anuncio}` : '',
    chat.ciudad ? `Ubicación guardada: ${chat.ciudad}${chat.estadoUS ? ', ' + nombreEstado(chat.estadoUS) : ''}${chat.codigoPostal ? ' ' + chat.codigoPostal : ''}.` : 'Todavía no sabes dónde vive: pregúntale su ciudad y código postal.',
    zona && chat.ciudad ? `Zona: ${zona.nombre || zona.id}. La cita presencial la atiende ${quienAtiende(zona)}${quienAtiende(zona) !== 'Tomás' ? ' (asesor del equipo de Tomás)' : ''}; por Meet la atiende Tomás.` : '',
    zona && !chat.ciudad ? `Por el anuncio, parece de ${zona.nombre || zona.id}. Confirma su ciudad y código postal con guardar_ubicacion antes de consultar horarios.` : '',
    !zona && chat.ciudad && hayZonas() ? 'Vive fuera de las zonas presenciales: la cita solo puede ser por Google Meet con Tomás.' : '',
    chat.aceptoDemo ? 'Ya aceptó recibir la demostración.' : '',
    citas.length ? `Este cliente YA tiene cita: ${citas.map(describir).join('; ')}.` : 'Este cliente todavía no tiene cita.',
    ofertaOriginal && !oferta ? `Llegó por la promoción "${ofertaOriginal.nombre}", pero no aplica donde vive: no la menciones más ni envíes su enlace.` : '',
    oferta && chat.experienciaEnviada ? `Ya le enviaste el enlace de "${oferta.nombre}"; no lo repitas salvo que te lo pida.` : '',
    chat.regalo ? `Regalo que obtuvo en "${ofertaOriginal?.nombre || 'la promoción'}": ${chat.regalo.nombre}${chat.regalo.codigo ? ' (código ' + chat.regalo.codigo + ')' : ''}.` +
      (chat.regalo.duplicado ? ' OJO: ese código ya lo había usado otra persona. No confirmes el regalo; dile con amabilidad que el equipo lo revisa y sigue con la cita.' : ' Celébralo en una frase y sigue con la coordinación de su cita. Si es por Meet, el regalo se lo enviamos a su casa después de la demostración.') : ''
  ].filter(Boolean).join('\n')

  const bloqueZonas = listado
    ? `\n\n## Zonas donde hacemos citas presenciales\n${listado}\nCuando el cliente te diga dónde vive, usa guardar_ubicacion con su zona. Si no está en ninguna, usa "ninguna" y ofrécele la cita por Google Meet.`
    : ''
  const bloqueOferta = oferta
    ? `\n\n## Promoción de este anuncio: ${oferta.nombre}\n${oferta.instrucciones || ''}`
    : ''
  return cargarInstrucciones() + bloqueZonas + bloqueOferta + '\n\n## Contexto de esta conversación\n' + contexto
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
 * @param {string} chatId
 * @param {{seguimiento?: number}} [opciones] seguimiento: 1 o 2 = mensaje de seguimiento sin herramientas
 * @returns {{texto, cita?, reprogramada?, humano?, ubicacion?, confirmada?, cancelada?, experiencia?, noInteresado?, aceptoDemo?}}
 */
export async function responder (chatId, opciones = {}) {
  const chat = obtenerChat(chatId)
  const mensajes = aMensajes(chat.historial)
  if (!mensajes.length) return { texto: '' }

  if (opciones.seguimiento) {
    const nota = opciones.seguimiento === 1
      ? 'NOTA INTERNA (no la escribió el cliente): pasó un día sin que conteste. Escríbele UN mensaje corto y amable de seguimiento, retomando donde quedaron (si ya le propusiste horarios, vuelve a ofrecer uno o dos). Sin presión, sin repetir lo que ya dijiste.'
      : 'NOTA INTERNA (no la escribió el cliente): pasaron unos días sin respuesta y este es el último seguimiento. Escríbele UN mensaje corto y cálido, déjale la puerta abierta ("cuando quieras, aquí estoy") y recuérdale el regalo premium de la cita. Sin presión.'
    if (mensajes[mensajes.length - 1].role === 'user') mensajes[mensajes.length - 1].content += '\n\n' + nota
    else mensajes.push({ role: 'user', content: nota })
    const r = await ia().messages.create({ model: config.modelo, max_tokens: 300, system: sistema(chat, { seguimiento: true }), messages: mensajes })
    return { texto: r.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim() }
  }

  const resultado = { texto: '' }
  for (let vuelta = 0; vuelta < 6; vuelta++) {
    const r = await ia().messages.create({
      model: config.modelo,
      max_tokens: 700,
      system: sistema(obtenerChat(chatId)),
      tools: HERRAMIENTAS,
      // en la última vuelta ya no usa herramientas: siempre termina con un mensaje para el cliente
      ...(vuelta === 5 ? { tool_choice: { type: 'none' } } : {}),
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

/** Resumen corto del chat para Tomás (cuando toma la conversación) */
export async function resumir (chatId) {
  const chat = obtenerChat(chatId)
  if (!chat?.historial?.length) return ''
  const conversacion = chat.historial.slice(-30).map(h => `${h.rol === 'cliente' ? 'Cliente' : h.rol === 'tomas' ? 'Tomás' : 'Sofía'}: ${h.texto}`).join('\n')
  const citas = citasVigentes(chatId)
  const datos = [
    chat.ciudad ? `Ubicación: ${chat.ciudad}${chat.estadoUS ? ', ' + chat.estadoUS : ''}${chat.codigoPostal ? ' ' + chat.codigoPostal : ''}` : '',
    citas.length ? `Cita: ${citas.map(c => formatoCita(c) + ' — ' + (c.modalidad === 'meet' ? 'Meet' : 'presencial')).join('; ')}` : 'Sin cita',
    chat.regalo ? `Regalo: ${chat.regalo.nombre}` : ''
  ].filter(Boolean).join('\n')
  const r = await ia().messages.create({
    model: config.modelo,
    max_tokens: 250,
    system: 'Resume esta conversación de WhatsApp para Tomás, que va a tomar el chat. En español, máximo 4 líneas cortas, sin saludos: quién es y qué quiere, en qué quedaron, qué falta o qué dudas tiene. No inventes nada.',
    messages: [{ role: 'user', content: `${datos}\n\n${conversacion}` }]
  })
  return r.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
}

const modalidadDe = (m) => (m === 'meet' || m === 'zoom' || m === 'virtual') ? 'meet' : 'presencial'

/** Texto extra para el evento del calendario (promoción y regalo) */
function extraCalendario (chat, modalidad) {
  const o = ofertaActiva(chat)
  return [
    o ? `Promoción: ${o.nombre}` : '',
    chat.regalo ? `Regalo obtenido: ${chat.regalo.nombre}${chat.regalo.codigo ? ' (' + chat.regalo.codigo + ')' : ''}` : '',
    modalidad === 'meet' ? 'Regalo: se envía a su casa después de la demostración.' : ''
  ].filter(Boolean).join('\n')
}

async function ejecutar (nombre, entrada, chat, resultado) {
  if (nombre === 'guardar_ubicacion') {
    const ciudad = String(entrada.ciudad || '').trim().slice(0, 80)
    // el ZIP guardado solo se reutiliza si es la misma ciudad (si se mudó, no arrastra el estado viejo)
    const mismaCiudad = chat.ciudad && ciudad && chat.ciudad.toLowerCase() === ciudad.toLowerCase()
    const zip = (String(entrada.codigo_postal || '').match(/\d{5}/) || [])[0] || (mismaCiudad ? chat.codigoPostal : '') || ''
    // el código postal manda: confirma el estado aunque el cliente o la IA digan otro
    const estado = estadoDesdeZip(zip) || codigoEstado(entrada.estado)
    let zona = null
    if (hayZonas()) {
      const elegida = entrada.zona && entrada.zona !== 'ninguna' ? zonaPorId(entrada.zona) : null
      const porUbicacion = zonaDesdeUbicacion(ciudad, estado)
      // si la IA eligió una zona que no cubre el estado del ZIP, gana la ubicación
      zona = elegida && (!estado || (elegida.estados || []).map(codigoEstado).includes(estado)) ? elegida : porUbicacion
    }
    const anterior = chat.zona || ''
    const ofertaOriginal = ofertaPorId(chat.oferta)
    const ofertaNoAplica = Boolean(ofertaOriginal && !ofertaValeEn(ofertaOriginal, estado))
    crearOActualizarChat(chat.id, { ciudad, estadoUS: estado, codigoPostal: zip, zona: zona?.id || '', ofertaNoAplica })
    if (zona && (!ofertaOriginal || !ofertaNoAplica)) marcarAvance(chat.id, 'cobertura', 'Cobertura validada')
    resultado.ubicacion = { zonaAnterior: anterior, zonaNueva: zona?.id || '', ciudad, estado, zip, fueraDeOferta: ofertaNoAplica ? ofertaOriginal.nombre : '' }
    if (!hayZonas()) return { guardado: true, nota: 'Ofrece primero la cita presencial.' }
    if (ofertaNoAplica && !zona) {
      return { guardado: true, presencial: false, nota: `La promoción "${ofertaOriginal.nombre}" no aplica en ${nombreEstado(estado) || 'su zona'}. Dile con amabilidad que vas a confirmar con el equipo la disponibilidad para su zona y usa pasar_a_humano. No le prometas nada.` }
    }
    if (!zona) return { guardado: true, presencial: false, nota: 'No hacemos citas presenciales ahí. Ofrécele la cita por Google Meet (modalidad meet).' }
    return {
      guardado: true,
      presencial: true,
      zona: zona.nombre || zona.id,
      atiendePresencial: quienAtiende(zona),
      nota: ofertaNoAplica
        ? `La promoción "${ofertaOriginal.nombre}" no aplica en su estado: no la menciones más. Sigue normal: ofrece la cita presencial con su regalo premium para la cocina.`
        : 'Ofrece la cita presencial (si no la aceptó ya) y propón dos horarios con consultar_disponibilidad.'
    }
  }

  if (nombre === 'consultar_disponibilidad') {
    const zona = zonaPorId(chat.zona)
    const modalidad = modalidadDe(entrada.modalidad)
    if (hayZonas() && !chat.ciudad) return { nota: 'Primero pregunta en qué ciudad vive y usa guardar_ubicacion.' }
    if (modalidad === 'presencial' && hayZonas() && !zona) return { nota: 'No hacemos citas presenciales donde vive. Ofrécele Google Meet.' }
    return { modalidad, ...consultarDisponibilidad({ fecha: entrada.fecha, hora: entrada.hora, zona, modalidad, tzCliente: tzDelCliente(chat) }) }
  }

  if (nombre === 'acepto_demostracion') {
    crearOActualizarChat(chat.id, { aceptoDemo: Date.now() })
    marcarAvance(chat.id, 'acepto', 'Aceptó la demostración')
    resultado.aceptoDemo = true
    return { ok: true, nota: 'Ahora propón dos horarios con consultar_disponibilidad.' }
  }

  if (nombre === 'agendar_cita') {
    const zona = zonaPorId(chat.zona)
    const modalidad = modalidadDe(entrada.modalidad)
    if (hayZonas() && !chat.ciudad) return { agendada: false, motivo: 'Primero confirma la ciudad del cliente con guardar_ubicacion.' }
    if (modalidad === 'presencial' && hayZonas() && !zona) return { agendada: false, motivo: 'Donde vive solo podemos hacer la cita por Google Meet.' }
    if (modalidad === 'presencial' && !String(entrada.direccion || '').trim()) return { agendada: false, motivo: 'Para la cita presencial falta la dirección completa.' }
    if (citasVigentes(chat.id).length) return { agendada: false, motivo: 'Ya tiene una cita. Si quiere cambiarla, usa reprogramar_cita.' }
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
      codigoPostal: chat.codigoPostal,
      notas: entrada.notas,
      zona,
      extraDescripcion: extraCalendario(chat, modalidad)
    })
    if (!r.ok) return { agendada: false, motivo: r.motivo }
    crearOActualizarChat(chat.id, { nombreReal: entrada.nombre, aceptoDemo: chat.aceptoDemo || Date.now() })
    marcarAvance(chat.id, 'cita', 'Cita agendada')
    resultado.cita = r.cita
    resultado.errorCalendario = r.errorCalendario
    const cuando = formatoHumano(DateTime.fromISO(r.cita.inicio).setZone(tzDelCliente(chat)))
    const o = ofertaActiva(obtenerChat(chat.id))
    const sigue = o && !chat.experienciaEnviada ? ` Después de confirmarle la cita, usa enviar_experiencia para mandarle el enlace de "${o.nombre}".` : ''
    return modalidad === 'meet'
      ? { agendada: true, modalidad: 'meet', cuando, enlaceMeet: r.cita.meetEnlace || null, nota: (r.cita.meetEnlace ? 'Comparte el enlace de Google Meet con el cliente.' : 'Dile que le enviarán el enlace de Google Meet antes de la cita.') + ' El regalo se lo enviamos a su casa después de la demostración.' + sigue }
      : { agendada: true, modalidad: 'presencial', cuando, direccion: r.cita.direccion, nota: sigue.trim() || undefined }
  }

  if (nombre === 'reprogramar_cita') {
    const anterior = citasVigentes(chat.id)[0]
    if (!anterior) return { ok: false, nota: 'No tiene una cita próxima: usa agendar_cita.' }
    const zona = zonaPorId(chat.zona)
    const modalidad = entrada.modalidad ? modalidadDe(entrada.modalidad) : anterior.modalidad
    const direccion = String(entrada.direccion || '').trim() || (modalidad === 'presencial' ? anterior.direccion : '')
    if (modalidad === 'presencial' && hayZonas() && !zona) return { ok: false, nota: 'Donde vive solo podemos hacer la cita por Google Meet.' }
    if (modalidad === 'presencial' && !direccion) return { ok: false, nota: 'Para la cita presencial falta la dirección completa.' }
    const r = await crearCita({
      modalidad,
      tzCliente: tzDelCliente(chat),
      chatId: chat.id,
      telefono: chat.telefono,
      nombre: anterior.nombre,
      inicioISO: entrada.inicio,
      direccion,
      ciudad: chat.ciudad || anterior.ciudad,
      estadoUS: chat.estadoUS,
      codigoPostal: chat.codigoPostal,
      notas: [anterior.notas, entrada.motivo ? `Reprogramada: ${entrada.motivo}` : 'Reprogramada'].filter(Boolean).join(' · '),
      zona,
      excluirId: anterior.id,
      extraDescripcion: extraCalendario(chat, modalidad)
    })
    // la anterior sigue en pie si la nueva no se pudo apartar
    if (!r.ok) return { ok: false, nota: r.motivo + ' La cita anterior sigue en pie.' }
    actualizarCita(r.cita.id, { reprogramadaDe: anterior.id })
    await cancelarCita(anterior.id, 'Reprogramada' + (entrada.motivo ? ': ' + entrada.motivo : ''))
    actualizarCita(anterior.id, { reprogramadaA: r.cita.id })
    resultado.reprogramada = { anterior, nueva: r.cita, motivo: entrada.motivo || '' }
    resultado.errorCalendario = r.errorCalendario
    const cuando = formatoHumano(DateTime.fromISO(r.cita.inicio).setZone(tzDelCliente(chat)))
    return { ok: true, cuando, modalidad, ...(modalidad === 'meet' ? { enlaceMeet: r.cita.meetEnlace || null } : { direccion }), nota: 'Confírmale el nuevo día y hora.' }
  }

  if (nombre === 'confirmar_cita') {
    const c = citasVigentes(chat.id)[0]
    if (!c) return { ok: false, nota: 'No tiene una cita próxima.' }
    actualizarCita(c.id, { confirmacion: 'confirmada', confirmadaEn: Date.now() })
    marcarAvance(chat.id, 'confirmada', 'Cita confirmada')
    resultado.confirmada = c
    return { ok: true, cuando: formatoCita(c), nota: 'Agradécele y recuérdale el regalo premium para su cocina.' }
  }

  if (nombre === 'cancelar_cita') {
    const c = citasVigentes(chat.id)[0]
    if (!c) return { ok: false, nota: 'No tiene una cita próxima.' }
    await cancelarCita(c.id, entrada.motivo || '')
    marcarAvance(chat.id, 'cancelada', 'Cita cancelada')
    resultado.cancelada = { ...c, motivo: entrada.motivo || '' }
    return { ok: true, nota: 'Cita cancelada. Despídete con amabilidad y déjale la puerta abierta.' }
  }

  if (nombre === 'enviar_experiencia') {
    const o = ofertaActiva(chat)
    if (!o || !o.enlace) return { ok: false, nota: 'Este cliente no tiene una promoción con enlace.' }
    if (!citasVigentes(chat.id).length) return { ok: false, nota: 'Primero aparta la cita; el enlace se envía después de agendar.' }
    if (chat.experienciaEnviada) return { ok: true, yaEnviada: true, nota: 'Ya se lo enviaste antes; no lo repitas salvo que te lo pida.' }
    resultado.experiencia = String(o.mensajeEnlace || '{enlace}').replace('{enlace}', o.enlace)
    return { ok: true, nota: 'El enlace sale en un mensaje aparte justo después del tuyo: NO lo copies. Tu mensaje debe ser una frase corta (por ejemplo, "Y ahora, lo divertido…") o nada.' }
  }

  if (nombre === 'marcar_no_interesado') {
    crearOActualizarChat(chat.id, { noInteresado: Date.now() })
    marcarAvance(chat.id, 'no_interesado', 'No interesado')
    resultado.noInteresado = { motivo: entrada.motivo || '' }
    return { ok: true, nota: 'Listo, no se le volverá a escribir. Despídete con amabilidad, sin presión.' }
  }

  if (nombre === 'pasar_a_humano') {
    resultado.humano = { motivo: entrada.motivo, resumen: entrada.resumen }
    return { ok: true, nota: 'Tomás fue avisado. Despídete brevemente diciendo que Tomás le escribirá pronto.' }
  }
  return { error: 'Herramienta desconocida' }
}

// Zonas de trabajo (estados / ciudades). Cada zona puede tener su propia hora local,
// sus horarios, quién atiende, a quién avisar y su propio CRM (cuenta de Royal Sales IA).
import { ajustes } from './config.js'

export const normalizar = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()

const ESTADOS = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', PR: 'Puerto Rico', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming'
}
const EN_ESPANOL = {
  tejas: 'TX', 'carolina del norte': 'NC', 'carolina del sur': 'SC', 'nueva york': 'NY',
  'nueva jersey': 'NJ', 'nuevo mexico': 'NM', luisiana: 'LA', pensilvania: 'PA',
  'virginia occidental': 'WV', 'dakota del norte': 'ND', 'dakota del sur': 'SD', misisipi: 'MS',
  'misuri': 'MO', 'hawai': 'HI', 'oregon': 'OR', 'florida': 'FL', 'georgia': 'GA'
}

/** Convierte "tx", "Texas", "Tejas" → "TX". Devuelve '' si no lo reconoce. */
export function codigoEstado (texto) {
  const t = normalizar(texto)
  if (!t) return ''
  const mayus = t.toUpperCase()
  if (ESTADOS[mayus]) return mayus
  for (const [cod, nombre] of Object.entries(ESTADOS)) if (normalizar(nombre) === t) return cod
  return EN_ESPANOL[t] || ''
}
export const nombreEstado = (cod) => ESTADOS[cod] || cod || ''

export function listaZonas () {
  return (Array.isArray(ajustes.zonas) ? ajustes.zonas : []).filter(z => z && z.id)
}
export const hayZonas = () => listaZonas().length > 0
export const zonaPorId = (id) => listaZonas().find(z => z.id === id) || null

const estadosDe = (z) => (z.estados || []).map(codigoEstado).filter(Boolean)
const ciudadesDe = (z) => (z.ciudades || []).map(normalizar).filter(Boolean)

/** Busca la zona por el texto del anuncio (título, descripción, enlace) usando "palabrasAnuncio". */
export function zonaDesdeAnuncio (textoAnuncio) {
  const t = ' ' + normalizar(textoAnuncio) + ' '
  if (!t.trim()) return null
  for (const z of listaZonas()) {
    for (const p of z.palabrasAnuncio || []) {
      const np = normalizar(p)
      if (np && t.includes(' ' + np + ' ')) return z
    }
  }
  return null
}

/** Busca la zona por ciudad y estado: primero por ciudad; si no, por estado cuando solo una zona lo cubre. */
export function zonaDesdeUbicacion (ciudad, estado) {
  const c = normalizar(ciudad)
  const e = codigoEstado(estado)
  const zonas = listaZonas()
  if (c) {
    const porCiudad = zonas.filter(z => ciudadesDe(z).includes(c) && (!e || !estadosDe(z).length || estadosDe(z).includes(e)))
    if (porCiudad.length) return porCiudad[0]
  }
  if (e) {
    const porEstado = zonas.filter(z => estadosDe(z).includes(e))
    if (porEstado.length === 1) return porEstado[0]
  }
  return null
}

const ESTE = ['CT','DE','DC','FL','GA','IN','KY','ME','MD','MA','MI','NH','NJ','NY','NC','OH','PA','PR','RI','SC','VT','VA','WV']
const CENTRO = ['AL','AR','IL','IA','KS','LA','MN','MS','MO','NE','ND','OK','SD','TN','TX','WI']
const MONTANA = ['CO','ID','MT','NM','UT','WY']
const PACIFICO = ['CA','NV','OR','WA']
/** Zona horaria principal de un estado (aproximada: algunos estados tienen dos) */
export function zonaHorariaEstado (cod) {
  const c = codigoEstado(cod)
  if (ESTE.includes(c)) return c === 'PR' ? 'America/Puerto_Rico' : 'America/New_York'
  if (CENTRO.includes(c)) return 'America/Chicago'
  if (MONTANA.includes(c)) return 'America/Denver'
  if (PACIFICO.includes(c)) return 'America/Los_Angeles'
  if (c === 'AZ') return 'America/Phoenix'
  if (c === 'AK') return 'America/Anchorage'
  if (c === 'HI') return 'Pacific/Honolulu'
  return ''
}

export const zonaHorariaDe = (zona) => zona?.zonaHoraria || ajustes.zonaHoraria || 'America/Chicago'
export const horariosDe = (zona) => zona?.horarios || ajustes.horarios || {}
export const quienAtiende = (zona) => zona?.atiende || 'Tomás'

/** Grupos de WhatsApp (por nombre) que reciben los avisos de la zona */
export function gruposDeZona (zona) {
  const v = zona?.avisarGrupo
  return (Array.isArray(v) ? v : (v ? [v] : [])).map(String).filter(Boolean)
}

/** Números (solo dígitos) a los que hay que avisar además de Tomás para esta zona. */
export function numerosDeZona (zona) {
  const v = zona?.avisarA
  const lista = Array.isArray(v) ? v : (v ? [v] : [])
  return lista.map(n => String(n).replace(/\D/g, '')).filter(n => n.length >= 8)
}

/** Texto con las zonas para que la IA sepa qué cubrimos y elija la correcta. */
export function zonasParaIA () {
  const zonas = listaZonas()
  if (!zonas.length) return ''
  return zonas.map(z => {
    const est = estadosDe(z).map(nombreEstado).join(', ')
    const ciu = (z.ciudades || []).join(', ')
    return `- id "${z.id}": ${z.nombre || z.id}${est ? ` — estados: ${est}` : ''}${ciu ? ` — ciudades y alrededores: ${ciu}` : ''}`
  }).join('\n')
}

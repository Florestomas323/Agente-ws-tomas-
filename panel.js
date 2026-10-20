// App web del agente: se instala en la pantalla de inicio del iPhone/iPad.
// Sirve la app (app.html), su ícono/manifiesto y una pequeña API JSON protegida con PANEL_CLAVE.
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DateTime } from 'luxon'
import { config, ajustes } from './config.js'
import { estadoWA, desvincular, enviarComoTomas, contestarAhora } from './whatsapp.js'
import {
  listarChats, listarCitas, obtenerChat, crearOActualizarChat, botActivo, cambiarBotActivo
} from './almacen.js'
import { ICONO_180, ICONO_192, ICONO_512 } from './icono.js'
import { listaZonas, zonaPorId, nombreEstado } from './zonas.js'

const aqui = path.dirname(fileURLToPath(import.meta.url))
const APP_HTML = fs.readFileSync(path.join(aqui, 'app.html'), 'utf8')
const zona = () => ajustes.zonaHoraria || 'America/Chicago'
const ficha = () => crypto.createHash('sha256').update('panel:' + config.panelClave).digest('hex').slice(0, 32)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const MANIFIESTO = JSON.stringify({
  name: 'Royal Cita IA',
  short_name: 'Royal Cita',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#F9FAFC',
  theme_color: '#060A13',
  lang: 'es',
  icons: [
    { src: '/icono-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icono-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
  ]
})

function autorizado (req) {
  if (!config.panelClave) return false
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')))
  return cookies.panel === ficha()
}

function leerCuerpo (req) {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', d => { b += d; if (b.length > 1e5) req.destroy() })
    req.on('end', () => {
      const tipo = req.headers['content-type'] || ''
      if (tipo.includes('application/json')) { try { return resolve(JSON.parse(b || '{}')) } catch { return resolve({}) } }
      resolve(Object.fromEntries(new URLSearchParams(b)))
    })
  })
}

// ---------- datos para la app ----------

function resumenChat (c) {
  const ult = c.historial[c.historial.length - 1]
  return {
    id: c.id,
    nombre: c.nombre || '',
    telefono: c.telefono || '',
    estado: c.estado === 'conocido' && c.pideInfo ? 'pide_info' : c.estado,
    origen: c.origen || '',
    anuncio: c.anuncio || '',
    zona: c.zona || '',
    zonaNombre: zonaPorId(c.zona)?.nombre || '',
    lugar: [c.ciudad, c.estadoUS ? nombreEstado(c.estadoUS) : ''].filter(Boolean).join(', '),
    crm: c.crm ? true : false,
    pausadoHasta: c.pausadoHasta || null,
    actualizado: c.actualizado || 0,
    ultimo: ult ? { rol: ult.rol, texto: ult.texto.slice(0, 160), t: ult.t } : null
  }
}

/** Chats que se muestran en la app: los del bot y los que ya tenías pero pidieron información */
const visible = (c) => c.estado !== 'conocido' || Boolean(c.pideInfo)

function datosEstado () {
  const chats = listarChats().filter(visible)
  const espera = (c) => c.estado === 'humano' || (c.estado === 'conocido' && c.pideInfo)
  const inicioHoy = DateTime.now().setZone(zona()).startOf('day').toMillis()
  const inicioSemana = DateTime.now().setZone(zona()).startOf('week').toMillis()
  const ahoraMs = Date.now()
  const citas = listarCitas().filter(c => c.estado === 'agendada')
  return {
    wa: {
      conectado: estadoWA.conectado,
      numero: estadoWA.numero,
      desde: estadoWA.desde,
      codigo: estadoWA.conectado ? '' : estadoWA.codigoVinculacion,
      qr: estadoWA.conectado ? '' : estadoWA.qrImagen,
      error: estadoWA.conectado ? '' : estadoWA.ultimoError
    },
    botActivo: botActivo(),
    zona: zona(),
    zonas: listaZonas().map(z => ({ id: z.id, nombre: z.nombre || z.id })),
    resumen: {
      prospectosHoy: chats.filter(c => (c.creado || 0) >= inicioHoy).length,
      prospectosSemana: chats.filter(c => (c.creado || 0) >= inicioSemana).length,
      citasSemana: citas.filter(c => (c.creada || 0) >= inicioSemana).length,
      citasProximas: citas.filter(c => Date.parse(c.fin) > ahoraMs).length,
      teToca: chats.filter(espera).length
    },
    pendientes: chats.filter(espera).slice(0, 10).map(resumenChat),
    proximas: citas.filter(c => Date.parse(c.fin) > ahoraMs).slice(0, 3)
  }
}

// ---------- página de entrada ----------

function paginaEntrar (error = '') {
  const sinClave = !config.panelClave
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#060A13"><meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Royal Cita"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest"><title>Royal Cita IA</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap">
<style>
:root{--menu:#060A13;--tarjeta:#0E121A;--tinta:#F3F5F9;--suave:#9298A5;--linea:rgba(255,255,255,.12);--primario:#2759D6}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--menu);color:var(--tinta);font:16px/1.45 "Geist",-apple-system,system-ui,sans-serif;display:grid;place-items:center;padding:24px;-webkit-font-smoothing:antialiased}
form{width:100%;max-width:360px}
.marca{display:flex;align-items:center;gap:12px;margin-bottom:28px}.marca img{width:48px;height:48px;border-radius:22%}
.marca b{display:block;font-size:18px;font-weight:600;letter-spacing:-.01em}.marca small{display:block;color:var(--suave);font-size:13px}
h1{font-size:26px;font-weight:700;letter-spacing:-.02em;margin:0 0 6px}p{color:var(--suave);margin:0 0 20px;font-size:15px}
label{display:block;font-size:13px;color:var(--suave);margin-bottom:6px}
input{width:100%;font:inherit;padding:12px 14px;border-radius:10px;border:1px solid var(--linea);background:var(--tarjeta);color:var(--tinta);outline:none}
input:focus{border-color:var(--primario);box-shadow:0 0 0 3px rgba(39,89,214,.35)}
button{width:100%;margin-top:14px;font:inherit;font-weight:600;padding:12px;border:0;border-radius:10px;background:var(--primario);color:#fff;cursor:pointer}
.error{color:#FF8A8A;margin-top:12px;font-size:14px}
</style></head><body>
<form method="post" action="/entrar">
<div class="marca"><img src="/apple-touch-icon.png" alt=""><div><b>Royal Cita IA</b><small>Agente de citas de Royal Sales IA</small></div></div>
${sinClave
    ? '<h1>Falta configurar</h1><p>Agrega la variable PANEL_CLAVE en Railway para proteger la app.</p>'
    : `<h1>Entrar</h1><p>Escribe la clave de Royal Cita IA.</p>
<label for="clave">Clave</label><input id="clave" type="password" name="clave" autocomplete="current-password" autofocus>
<button>Entrar</button>${error ? `<div class="error">${esc(error)}</div>` : ''}`}
</form></body></html>`
}

// ---------- servidor ----------

export function iniciarPanel () {
  const servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const html = (h, codigo = 200, extra = {}) => { res.writeHead(codigo, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(h) }
    const json = (obj, codigo = 200) => { res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)) }
    const png = (b64) => { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }); res.end(Buffer.from(b64, 'base64')) }
    const ir = (a, extra = {}) => { res.writeHead(303, { Location: a, ...extra }); res.end() }

    try {
      // públicos
      if (url.pathname === '/salud') { res.writeHead(200); return res.end('ok') }
      if (url.pathname === '/manifest.webmanifest') { res.writeHead(200, { 'Content-Type': 'application/manifest+json' }); return res.end(MANIFIESTO) }
      if (url.pathname === '/apple-touch-icon.png') return png(ICONO_180)
      if (url.pathname === '/icono-192.png') return png(ICONO_192)
      if (url.pathname === '/icono-512.png') return png(ICONO_512)

      if (url.pathname === '/entrar' && req.method === 'POST') {
        const { clave } = await leerCuerpo(req)
        if (config.panelClave && clave === config.panelClave) {
          return ir('/', { 'Set-Cookie': `panel=${ficha()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000` })
        }
        return html(paginaEntrar('Clave incorrecta'), 401)
      }
      if (url.pathname === '/salir') return ir('/', { 'Set-Cookie': 'panel=; Path=/; Max-Age=0' })

      const ok = autorizado(req)
      if (url.pathname.startsWith('/api/') && !ok) return json({ error: 'sin_sesion' }, 401)
      if (!ok) return html(paginaEntrar())

      // ---- API ----
      if (url.pathname === '/api/estado') return json(datosEstado())

      if (url.pathname === '/api/chats') {
        return json({ chats: listarChats().filter(visible).slice(0, 200).map(resumenChat) })
      }

      if (url.pathname === '/api/chat') {
        const c = obtenerChat(url.searchParams.get('id'))
        if (!c) return json({ error: 'no_encontrado' }, 404)
        return json({
          chat: { ...resumenChat(c), historial: c.historial },
          citas: listarCitas().filter(x => x.chatId === c.id)
        })
      }

      if (url.pathname === '/api/citas') return json({ citas: listarCitas() })

      if (url.pathname === '/api/accion' && req.method === 'POST') {
        const { accion, id } = await leerCuerpo(req)
        const existe = id && obtenerChat(id)
        if (accion === 'bot_on') cambiarBotActivo(true)
        else if (accion === 'bot_off') cambiarBotActivo(false)
        else if (accion === 'activar' && existe) { crearOActualizarChat(id, { estado: 'prospecto', pausadoHasta: null, pideInfo: null }); contestarAhora(id) }
        else if (accion === 'pausar' && existe) crearOActualizarChat(id, { estado: 'pausado', pausadoHasta: null })
        else if (accion === 'ignorar' && existe) crearOActualizarChat(id, { estado: 'conocido', pideInfo: null })
        else if (accion === 'desvincular') await desvincular()
        else return json({ error: 'accion_invalida' }, 400)
        return json({ ok: true })
      }

      if (url.pathname === '/api/enviar' && req.method === 'POST') {
        const { id, texto } = await leerCuerpo(req)
        try {
          await enviarComoTomas(id, texto)
          return json({ ok: true })
        } catch (e) {
          return json({ error: e.message }, 400)
        }
      }

      if (url.pathname.startsWith('/api/')) return json({ error: 'no_existe' }, 404)

      // ---- la app ----
      return html(APP_HTML)
    } catch (e) {
      console.error('Error en el panel', e)
      if (url.pathname.startsWith('/api/')) return json({ error: e.message }, 500)
      html('Error: ' + esc(e.message), 500)
    }
  })
  servidor.listen(config.puerto, () => console.log(`Panel en el puerto ${config.puerto}`))
  return servidor
}

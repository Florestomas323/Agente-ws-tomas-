# Royal Cita IA — agente de citas por WhatsApp (Impact Enterprises)

El bot se presenta como **Sofía**, la asistente virtual de Tomás. Su único objetivo es **agendar citas de 30 a 40 minutos**: primero presencial y, si no se puede, por Zoom. Nunca da precios.

Contesta solo a las personas que te escriben desde tus campañas de Facebook/Instagram, las califica, les ofrece horarios libres de tu Google Calendar y agenda la demostración. Cuando agenda o cuando necesita que tú intervengas, te avisa por WhatsApp.

Todo se instala desde el iPhone: **GitHub** (código) → **Railway** (servidor 24/7, unos $5 al mes) → **Google Apps Script** (conexión con tu calendario, gratis).

---

## Cómo se comporta

| Situación | Qué hace el bot |
|---|---|
| Alguien escribe desde un anuncio “clic a WhatsApp” | Contesta, pide nombre y ciudad, ofrece la demo y agenda |
| El primer mensaje trae una frase clave (ej. “quiero más información”) | Lo trata como prospecto de campaña |
| Amigos, familia, clientes que ya tenías, grupos | **No contesta** |
| Tú escribes a mano en un chat que lleva el bot | El bot se calla en ese chat por 24 h |
| Cliente actual, queja, duda que no sabe, zona que no cubres | Te avisa (“Te toca a ti”) y deja de contestar en ese chat |
| Cliente manda varios mensajes seguidos | Espera unos segundos y contesta todo junto |
| Cada respuesta | Pone el visto, se toma un momento, aparece “escribiendo…” al ritmo de una persona y nunca tarda exactamente lo mismo |
| Agenda una cita | Crea el evento en tu Google Calendar (azul Pavo real) y te manda el resumen |

Cuando vinculas el número, todos los chats que ya existían quedan marcados como “ignorados”, así el bot nunca les contesta a tus clientes actuales.

---

## Paso 1 — Subir el código a GitHub
1. En github.com (Safari) → **+** → **New repository** → nombre `agente-citas-whatsapp` → **Private** → Create.
2. Descomprime el zip en la app Archivos.
3. En el repo: **Add file → Upload files** → selecciona **todos** los archivos del zip → Commit.

## Paso 2 — Clave de la IA
En console.anthropic.com → **API Keys** → **Create Key**. Cópiala; la usarás en el paso 3.

## Paso 3 — Servidor en Railway
1. Entra a railway.com con tu cuenta de GitHub y activa el plan Hobby.
2. **New Project → Deploy from GitHub repo** → elige `agente-citas-whatsapp`.
3. **Volumen (importante: ahí se guarda la sesión de WhatsApp y las citas):** en el proyecto toca **Create → Volume**, conéctalo al servicio y pon como ruta de montaje (*mount path*) `/data`.
4. En el servicio → **Variables** → agrega:

| Variable | Valor |
|---|---|
| `ANTHROPIC_API_KEY` | la clave del paso 2 |
| `NUMERO_WHATSAPP` | el número que vas a vincular, con 1 adelante y sin signos. Ej: `16823811576` |
| `PANEL_CLAVE` | una clave para entrar al panel |
| `DATA_DIR` | `/data` |
| `NUMERO_AVISOS` | *(opcional)* número donde quieres los avisos. Vacío = te llegan al chat “Tú” (mensaje a ti mismo) |
| `CALENDARIO_URL` | *(paso 5)* URL del Apps Script |
| `CALENDARIO_CLAVE` | *(paso 5)* la clave que pongas en el Apps Script |
| `MODELO_IA` | *(opcional)* por defecto `claude-sonnet-5-5` |
| `ZOOM_LINK` | *(opcional)* tu sala personal de Zoom. Si la pones, Sofía la comparte al agendar por Zoom; si no, le dice al cliente que le enviarán el enlace |

5. **Settings → Networking → Generate Domain**. Esa dirección es tu **panel**. Guárdala en tu pantalla de inicio.

## Paso 4 — Vincular WhatsApp
1. Abre el panel, entra con tu `PANEL_CLAVE`.
2. Vas a ver un **código de 8 letras**.
3. En WhatsApp Business: **Ajustes → Dispositivos vinculados → Vincular un dispositivo → “Vincular con el número de teléfono”** y escribe el código.
4. El panel cambia a **● Conectado**. Tu teléfono sigue funcionando normal.

> Recomendación: prueba primero con un número secundario. Escríbele desde otro teléfono la frase de tu anuncio y revisa cómo contesta.

## Paso 5 — Conectar tu Google Calendar
Sin esto el bot funciona, pero no ve tus otras citas (cobranza, servicio…) y podría ofrecer un horario que ya tienes ocupado.

1. En Safari abre script.google.com (si se ve mal, usa **aA → Solicitar sitio de escritorio**).
2. **Nuevo proyecto** → borra lo que hay → pega el contenido de `Code.gs`.
3. Cambia `CAMBIA-ESTA-CLAVE` por una clave tuya → guardar.
4. **Implementar → Nueva implementación → ⚙️ Aplicación web**
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier usuario**
5. Autoriza (si sale “Google no verificó esta app”: **Configuración avanzada → Ir a…**). Es tu propio script.
6. Copia la URL que termina en `/exec` → en Railway: `CALENDARIO_URL` = esa URL y `CALENDARIO_CLAVE` = tu clave.
7. Prueba: abre la URL en Safari; debe decir “Puente de calendario funcionando”.

Todos los eventos de tu calendario cuentan como ocupado (menos los de todo el día), con 30 min de margen para manejar.

## Paso 6 — Ajustar a tu gusto (desde GitHub)
Cada vez que guardas un cambio en GitHub, Railway se actualiza solo en un minuto **sin perder la vinculación**.

- **`negocio.md`**: cómo habla el bot, qué ofrece, zonas, reglas. Revisa las líneas marcadas **[EDITAR]** (regalo/promoción, zonas, si pides que esté la pareja).
- **`ajustes.json`**:
  - `frasesClave`: pon aquí el **mensaje prellenado de tu anuncio**.
  - `horarios`: horas que puede ofrecer cada día.
  - `duracionCitaMinutos`, `margenTrasladoMinutos`, `anticipacionMinimaHoras`.
  - `calendario.invitados`: correos que quieres invitados en cada cita.
  - `modoRespuesta`: `campanas` (recomendado), `nuevos` o `todos`.

---

## Varios estados (zonas) y CRM por estado
En `ajustes.json` → `"zonas"` defines cada estado o región:
- `ciudades` y `estados` que cubre (la IA entiende también las ciudades de alrededor).
- `palabrasAnuncio`: palabras que el bot busca en el texto visible del anuncio y en el mensaje prellenado (por ejemplo "Florida" o un código como "(FL)"). El nombre interno de la campaña en el Administrador de anuncios NO llega por WhatsApp, así que la palabra debe estar en el título o texto del anuncio, o en el mensaje prellenado.
- `zonaHoraria`: para que los horarios salgan en la hora local del cliente.
- `atiende` y `avisarA`: quién va a la cita y su WhatsApp. Esa persona recibe los avisos de su zona; tú recibes todos.
- `crmClaveVariable`: el nombre de la variable de Railway con la clave de integración de la cuenta de Royal Sales IA de esa zona.

Cómo funciona:
1. Alguien escribe desde un anuncio → te llega **📣 Nuevo prospecto** con el nombre del anuncio y la zona (si el anuncio la delata).
2. El bot pregunta la ciudad y la confirma → te llega **🧭 dijo dónde vive** con su ciudad, estado y zona. Si está fuera de tus zonas, no agenda y te avisa.
3. El prospecto entra al **CRM de su zona** (Royal Sales IA → Leads), con el anuncio de donde vino.
4. Al agendar, la cita se guarda en la hora local, te avisa a ti y a quien atiende, y se actualiza en el CRM.

Variables de Railway para el CRM:
| Variable | Valor |
|---|---|
| `ROYAL_SALES_URL` | la dirección de tu Royal Sales IA, por ejemplo `https://royal-sales-ia.vercel.app` |
| `CRM_CLAVE_TX_CENTRAL`, `CRM_CLAVE_DFW`, … | la clave de integración de cada cuenta (en Royal Sales IA: Integraciones → Sitio web). Un nombre por zona, el que pusiste en `crmClaveVariable` |
| `CRM_CLAVE` | *(opcional)* clave única si todo va a una sola cuenta |

## La app
Tu panel es una app: ábrela en Safari, toca **Compartir → Agregar a pantalla de inicio** y queda con su ícono, a pantalla completa.
- **Hoy**: quién te está esperando ("te toca a ti"), los números de la semana y las próximas citas.
- **Chats**: todas las conversaciones del bot, con filtros (Te toca, Bot, En pausa). Dentro de cada chat puedes **escribirle tú al cliente**; al hacerlo, el bot se pausa en ese chat.
- **Citas**: las citas agendadas, con botones para WhatsApp y Cómo llegar.
- **Ajustes**: encender o apagar el bot, estado de WhatsApp (y el código de vinculación cuando haga falta) y cerrar sesión.
Se actualiza sola cada pocos segundos mientras la tienes abierta.

## Cuidados con WhatsApp
Baileys no es la API oficial; WhatsApp puede bloquear números que usan automatización. Este bot está hecho para bajar ese riesgo: **solo contesta a quien te escribe primero**, simula que está escribiendo, espera entre mensajes, no manda mensajes masivos y tiene un límite diario por chat. Aun así, no lo uses para enviar promociones en masa.

## Costos aproximados
- Railway Hobby: unos $5 al mes.
- IA: unos centavos por conversación con pocos prospectos al día.
- Apps Script: gratis.

## Archivos
| Archivo | Para qué |
|---|---|
| `negocio.md` | Instrucciones del asistente (lo que más vas a editar) |
| `estilo.md` | Habilidad de trato humano: cómo conversa (empatía, tono, ritmo, honestidad) |
| `ajustes.json` | Horarios y reglas |
| `index.js` | Arranque |
| `whatsapp.js` | Conexión con WhatsApp (Baileys) |
| `manejador.js` | A quién contestar, pausas, avisos |
| `agente.js` | Conversación con la IA y sus herramientas |
| `calendario.js` | Horarios libres y creación de citas |
| `almacen.js` | Guarda chats y citas en `/data` |
| `zonas.js` | Zonas por estado: detección por anuncio y ciudad |
| `crm.js` | Envía prospectos y citas al CRM de cada zona |
| `panel.js` | Servidor de la app y sus datos |
| `app.html` | La app (pantallas Hoy, Chats, Citas, Ajustes) |
| `icono.js` | Ícono de la app |
| `Code.gs` | Se pega en Google Apps Script, **no** hace falta subirlo a GitHub |

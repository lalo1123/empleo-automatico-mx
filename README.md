# Empleo Automático MX — por SkyBrandMX

Extensión de Chrome: copiloto con IA para postularte a empleos en México **sin que te baneen**.

## Por qué no es como AIApply / LazyApply / Sonara

Esas herramientas postulan automáticamente sin que veas nada. En la práctica:

- 23% de los usuarios de auto-apply tienen su cuenta de LinkedIn restringida en los primeros 90 días (Growleads, 2026).
- Las cartas son plantillas idénticas para 700 vacantes — los reclutadores las marcan como spam.
- Cuando el portal detecta el patrón, baja tu visibilidad en búsquedas o cierra tu cuenta.

**Empleo Automático MX hace lo opuesto:**

- 1 carta personalizada por vacante con tu CV real (no plantillas).
- Cada postulación se ve como sesión humana normal — los portales no detectan nada anómalo.
- Tú das el último clic — siempre. Cero envíos automáticos en planes Free/Pro.
- En LinkedIn e Indeed: límite responsable de 15/día (recomendación industry-standard de seguridad).

**Una postulación bien hecha vence a 50 genéricas.** Los datos lo respaldan: tasas de respuesta de cartas personalizadas son ~5x más altas que plantillas.

## Estado

MVP comercial vivo. Soporta **6 portales mexicanos**: OCC Mundial, Computrabajo, Bumeran, LaPieza, Indeed México y LinkedIn (Easy Apply, con límite responsable de 15/día).

## Cómo funciona

1. Creas tu cuenta gratis en [empleo.skybrandmx.com/signup](https://empleo.skybrandmx.com/signup).
2. Instalas la extensión y la conectas con tu cuenta (Opciones → Iniciar sesión).
3. Subes tu CV (PDF) una vez — se parsea y se guarda en tu perfil.
4. Navegas cualquiera de los 6 portales. Al abrir una vacante, aparece un botón flotante "✨ Postular con IA".
5. La IA genera una carta de presentación personalizada y llena el formulario.
6. Tú revisas, editas si quieres, y das el último clic para enviar.

**Tú siempre das el último clic.** La extensión nunca envía una postulación sin tu aprobación explícita.

## Planes

| Plan     | Precio (MXN/mes) | Postulaciones        |
|----------|------------------|----------------------|
| Gratis   | $0               | 3 / mes              |
| Pro      | $299             | 100 / mes            |
| Premium  | $499             | Hasta 30 / día       |

Cambios de plan y facturación en [empleo.skybrandmx.com/account/billing](https://empleo.skybrandmx.com/account/billing).

## Instalación (modo desarrollo)

1. Clona / descarga este repo.
2. Abre Chrome → `chrome://extensions`.
3. Activa "Modo de desarrollador" (arriba a la derecha).
4. Clic en "Cargar descomprimida" → selecciona la carpeta raíz del repo.
5. Abre la página de opciones de la extensión:
   - Inicia sesión (o crea tu cuenta gratis).
   - Sube tu CV en PDF.
6. Ve a una vacante en occ.com.mx y prueba.

## Qué necesitas

- Google Chrome o cualquier navegador basado en Chromium (Edge, Brave, Arc).
- Cuenta en empleo.skybrandmx.com (el Plan Gratis incluye 3 postulaciones al mes).
- Cuenta activa logueada en al menos uno de los 6 portales soportados (OCC, Computrabajo, Bumeran, LaPieza, Indeed, LinkedIn).
- Tu CV en PDF.

## Arquitectura

Ver [ARCHITECTURE.md](./ARCHITECTURE.md).

## Privacidad

Tu perfil y drafts viven en `chrome.storage.local` (nunca se exponen a otras páginas). Tu correo, hash de contraseña, texto del CV y el job posting se envían a nuestro backend (`api.empleo.skybrandmx.com`) para generar las cartas y llevar el conteo de postulaciones de tu plan. La clave de Gemini vive únicamente en nuestro servidor; nunca llega a tu navegador.

## Licencia

Por definir.

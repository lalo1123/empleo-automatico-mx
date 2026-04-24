# Empleo Automático MX — por SkyBrandMX

Extensión de Chrome: copiloto con IA para postularte a empleos en México.

## Estado

MVP comercial. Soporta: **OCC Mundial** (occ.com.mx).
En roadmap: Computrabajo, LinkedIn, Bumeran.

## Cómo funciona

1. Creas tu cuenta gratis en [skybrandmx.com/signup](https://skybrandmx.com/signup).
2. Instalas la extensión y la conectas con tu cuenta (Opciones → Iniciar sesión).
3. Subes tu CV (PDF) una vez — se parsea y se guarda en tu perfil.
4. Navegas OCC normalmente. Al abrir una vacante, aparece un botón flotante "Postular con IA".
5. La IA genera una carta de presentación personalizada y llena el formulario.
6. Tú revisas, editas si quieres, y das el último clic para enviar.

**Tú siempre das el último clic.** La extensión nunca envía una postulación sin tu aprobación explícita.

## Planes

| Plan     | Precio (MXN/mes) | Postulaciones/mes |
|----------|------------------|-------------------|
| Gratis   | $0               | 3                 |
| Pro      | $199             | 100               |
| Premium  | $399             | Ilimitado         |

Cambios de plan y facturación en [skybrandmx.com/account/billing](https://skybrandmx.com/account/billing).

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
- Cuenta en skybrandmx.com (el Plan Gratis incluye 3 postulaciones al mes).
- Cuenta activa de OCC Mundial (logueada en tu navegador).
- Tu CV en PDF.

## Arquitectura

Ver [ARCHITECTURE.md](./ARCHITECTURE.md).

## Privacidad

Tu perfil y drafts viven en `chrome.storage.local` (nunca se exponen a otras páginas). Tu correo, hash de contraseña, texto del CV y el job posting se envían a nuestro backend (`api.skybrandmx.com`) para generar las cartas y llevar el conteo de postulaciones de tu plan. La clave de Gemini vive únicamente en nuestro servidor; nunca llega a tu navegador.

## Licencia

Por definir.

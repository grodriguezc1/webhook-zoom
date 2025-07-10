require('dotenv').config({ path: 'example.env' });
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Verificación de variables
if (!process.env.ZOOM_WEBHOOK_SECRET_TOKEN || !process.env.N8N_WEBHOOK_URL || !process.env.ZOOM_ACCESS_TOKEN) {
  console.error('❌ Error: Variables de entorno faltantes en example.env');
  process.exit(1);
}

// Routes
app.post('/webhook', async (req, res) => {
  try {
    console.log('📩 Evento recibido:', req.body.event);

    // Validación de firma Zoom
    const message = `v0:${req.headers['x-zm-request-timestamp']}:${JSON.stringify(req.body)}`;
    const signature = `v0=${crypto.createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN)
      .update(message)
      .digest('hex')}`;

    if (signature !== req.headers['x-zm-signature']) {
      console.error('🚫 Firma inválida');
      return res.status(401).json({ error: 'Firma no válida' });
    }

    // Validación inicial de Zoom
    if (req.body.event === 'endpoint.url_validation') {
      const responseToken = crypto.createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN)
        .update(req.body.payload.plainToken)
        .digest('hex');
      
      return res.json({
        plainToken: req.body.payload.plainToken,
        encryptedToken: responseToken
      });
    }

    // Procesar solo webinar.ended
    if (req.body.event === 'webinar.ended') {
      console.log('🔄 Procesando webinar:', req.body.payload.id);
      
      let allParticipants = [];
      let nextToken = req.body.payload.next_page_token || '';
      let currentPage = 1;

      // Procesar primera página (datos del webhook)
      if (req.body.payload.participants && Array.isArray(req.body.payload.participants)) {
        allParticipants = [...req.body.payload.participants];
        console.log(`📄 Página 1: ${allParticipants.length} participantes`);
      }

      // Paginación automática para páginas adicionales
      while (nextToken && nextToken !== '' && currentPage < 10) {
        try {
          const zoomResponse = await axios.get(
            `https://api.zoom.us/v2/past_webinars/${req.body.payload.id}/participants`,
            {
              headers: {
                'Authorization': `Bearer ${process.env.ZOOM_ACCESS_TOKEN}`
              },
              params: {
                page_size: 300, // Máximo permitido por Zoom
                next_page_token: nextToken
              },
              timeout: 5000
            }
          );

          if (zoomResponse.data.participants && Array.isArray(zoomResponse.data.participants)) {
            allParticipants = [...allParticipants, ...zoomResponse.data.participants];
            currentPage++;
            nextToken = zoomResponse.data.next_page_token || '';
            console.log(`📄 Página ${currentPage}: ${zoomResponse.data.participants.length} participantes`);
          } else {
            break;
          }
        } catch (error) {
          console.error('⚠️ Error en paginación:', error.message);
          break;
        }
      }

      // Enviar datos consolidados a n8n
      const response = await axios.post(
        process.env.N8N_WEBHOOK_URL,
        {
          event: req.body.event,
          payload: {
            ...req.body.payload, // Mantener todos los datos originales
            participants: allParticipants, // Todos los participantes consolidados
            total_participants: allParticipants.length // Nuevo campo agregado
          },
          metadata: {
            server: 'Zoom Webhook Proxy',
            timestamp: new Date().toISOString(),
            pages_processed: currentPage
          }
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000
        }
      );

      console.log(`✅ Enviados ${allParticipants.length} participantes a n8n`);
      return res.status(200).json({ success: true });
    }

    res.status(200).end(); // Respuesta para otros eventos

  } catch (error) {
    console.error('🔥 Error crítico:', error.message);
    const statusCode = error.response?.status || 500;
    res.status(statusCode).json({
      error: 'Error en el servidor',
      details: error.message,
      ...(error.response && { responseData: error.response.data })
    });
  }
});

// Iniciar servidor
app.listen(port, () => {
  console.log(`
  🚀 Servidor activo en puerto ${port}
  📌 Variables cargadas desde example.env
  🔗 Endpoint n8n: ${process.env.N8N_WEBHOOK_URL}
  `);
});

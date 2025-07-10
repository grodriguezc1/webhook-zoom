require('dotenv').config({ path: 'example.env' });
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Verificación de variables
if (!process.env.ZOOM_WEBHOOK_SECRET_TOKEN || !process.env.N8N_WEBHOOK_URL) {
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
      console.log('🔄 Reenviando a:', process.env.N8N_WEBHOOK_URL);
      
      const response = await axios.post(
        process.env.N8N_WEBHOOK_URL,
        {
          event: req.body.event,
          payload: req.body.payload,
          metadata: {
            server: 'Zoom Webhook Proxy',
            timestamp: new Date().toISOString()
          }
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000
        }
      );

      console.log(`✅ Éxito (Status: ${response.status})`);
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

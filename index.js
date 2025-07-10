require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Configuración crítica
const REQUIRED_ENV = ['ZOOM_WEBHOOK_SECRET_TOKEN', 'N8N_WEBHOOK_URL'];
const missing = REQUIRED_ENV.filter(key => !process.env[key]);

if (missing.length > 0) {
  console.error('❌ Faltan variables de entorno:', missing);
  process.exit(1);
}

// Routes
app.post('/webhook', async (req, res) => {
  try {
    console.log('📩 Evento:', req.body.event);

    // Validación de firma
    const message = `v0:${req.headers['x-zm-request-timestamp']}:${JSON.stringify(req.body)}`;
    const signature = `v0=${crypto.createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN)
      .update(message)
      .digest('hex')}`;

    if (signature !== req.headers['x-zm-signature']) {
      return res.status(401).send('Firma inválida');
    }

    // Validación inicial de Zoom
    if (req.body.event === 'endpoint.url_validation') {
      const encryptedToken = crypto.createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN)
        .update(req.body.payload.plainToken)
        .digest('hex');
      
      return res.json({
        plainToken: req.body.payload.plainToken,
        encryptedToken
      });
    }

    // Procesar solo webinars terminados
    if (req.body.event === 'webinar.ended') {
      console.log('🔄 Enviando a n8n...');
      
      await axios.post(process.env.N8N_WEBHOOK_URL, {
        zoomEvent: req.body,
        receivedAt: new Date().toISOString()
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      });

      console.log('✅ Enviado correctamente');
      return res.status(200).json({ success: true });
    }

    res.status(200).end(); // Para otros eventos

  } catch (error) {
    console.error('🔥 Error:', error.message);
    res.status(500).json({ 
      error: 'Error interno',
      details: error.message 
    });
  }
});

app.listen(port, () => {
  console.log(`🚀 Servidor listo en puerto ${port}`);
  console.log(`🔗 URL n8n configurada: ${process.env.N8N_WEBHOOK_URL || 'NO CONFIGURADA'}`);
});

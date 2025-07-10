require('dotenv').config()
const express = require('express')
const bodyParser = require('body-parser')
const crypto = require('crypto')
const axios = require('axios')

const app = express()
const port = process.env.PORT || 3000

app.use(bodyParser.json())

app.get('/', (req, res) => {
  res.status(200)
  res.send(`Zoom Webhook sample successfully running. Set this URL with the /webhook path as your apps Event notification endpoint URL. https://github.com/zoom/webhook-sample`)
})

app.post('/webhook', async (req, res) => {
  console.log(req.headers)
  console.log(req.body)

  const message = `v0:${req.headers['x-zm-request-timestamp']}:${JSON.stringify(req.body)}`
  const hashForVerify = crypto.createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN).update(message).digest('hex')
  const signature = `v0=${hashForVerify}`

  if (req.headers['x-zm-signature'] === signature) {

    if (req.body.event === 'endpoint.url_validation') {
      const hashForValidate = crypto.createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN).update(req.body.payload.plainToken).digest('hex')

      const response = {
        message: {
          plainToken: req.body.payload.plainToken,
          encryptedToken: hashForValidate
        },
        status: 200
      }

      console.log(response.message)
      res.status(response.status).json(response.message)

    } else {
      const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL
      console.log('📦 URL de webhook n8n:', n8nWebhookUrl)

      // Validar que la URL esté bien formada
      try {
        new URL(n8nWebhookUrl)
      } catch (error) {
        console.error('❌ URL inválida detectada:', n8nWebhookUrl)
        return res.status(400).json({ message: 'URL de webhook de n8n inválida' })
      }

      try {
        await axios({
          method: 'post',
          url: n8nWebhookUrl,
          headers: { 'Content-Type': 'application/json' },
          data: req.body
        })
        console.log('✅ Evento enviado a n8n con éxito')
        res.status(200).json({ message: 'Evento recibido y reenviado a n8n' })
      } catch (err) {
        console.error('❌ Error enviando evento a n8n:', err.message)
        res.status(500).json({ message: 'Error enviando evento a n8n' })
      }
    }

  } else {
    console.log('Unauthorized request to Zoom Webhook sample.')
    res.status(401).json({ message: 'Unauthorized request to Zoom Webhook sample.' })
  }
})

app.listen(port, () => console.log(`Zoom Webhook sample listening on port ${port}!`))


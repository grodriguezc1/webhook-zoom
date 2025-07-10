require('dotenv').config()
const express = require('express')
const bodyParser = require('body-parser')
const crypto = require('crypto')
const axios = require('axios') // <-- agregamos axios para llamadas HTTP

const app = express()
const port = process.env.PORT || 3000

app.use(bodyParser.json())

app.get('/', (req, res) => {
  res.status(200)
  res.send(`Zoom Webhook sample successfully running. Set this URL with the /webhook path as your apps Event notification endpoint URL. https://github.com/zoom/webhook-sample`)
})

app.post('/webhook', async (req, res) => {  // async porque haremos await
  var response

  console.log(req.headers)
  console.log(req.body)

  // construct the message string
  const message = `v0:${req.headers['x-zm-request-timestamp']}:${JSON.stringify(req.body)}`

  const hashForVerify = crypto.createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN).update(message).digest('hex')

  // hash the message string with your Webhook Secret Token and prepend the version semantic
  const signature = `v0=${hashForVerify}`

  // you validating the request came from Zoom https://marketplace.zoom.us/docs/api-reference/webhook-reference#notification-structure
  if (req.headers['x-zm-signature'] === signature) {

    // Zoom validating you control the webhook endpoint https://marketplace.zoom.us/docs/api-reference/webhook-reference#validate-webhook-endpoint
    if(req.body.event === 'endpoint.url_validation') {
      const hashForValidate = crypto.createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN).update(req.body.payload.plainToken).digest('hex')

      response = {
        message: {
          plainToken: req.body.payload.plainToken,
          encryptedToken: hashForValidate
        },
        status: 200
      }

      console.log(response.message)

      res.status(response.status)
      res.json(response.message)
    } else {
      // Aquí recibes eventos reales, envíalos a n8n:

      const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL;

      axios.post(n8nWebhookUrl, {
        event: req.body.event,
        payload: req.body.payload
      })
      .then(() => {
        console.log('Evento enviado a n8n con éxito');
        res.status(200).json({ message: 'Evento recibido y reenviado a n8n' });
      })
      .catch(err => {
        console.error('Error enviando evento a n8n:', err.message);
        res.status(500).json({ message: 'Error enviando evento a n8n' });
      });
    }
  } else {

    response = { message: 'Unauthorized request to Zoom Webhook sample.', status: 401 }

    console.log(response.message)

    res.status(response.status)
    res.json(response)
  }
})

app.listen(port, () => console.log(`Zoom Webhook sample listening on port ${port}!`))

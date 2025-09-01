const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware for raw body (needed for Stripe webhook signature verification)
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// Gmail transporter setup
const transporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

// In-memory log storage (in production, consider using a database)
let logs = [];
function addLog(message, type = 'info') {
  const logEntry = {
    timestamp: new Date().toISOString(),
    message,
    type
  };
  logs.push(logEntry);
  console.log(`[${type.toUpperCase()}] ${message}`);
  // Keep only last 100 logs
  if (logs.length > 100) {
    logs = logs.slice(-100);
  }
}

// Format payment failure details for email
function formatFailureEmail(event) {
  const { type, data } = event;
  let subject = 'Stripe Payment Failure Alert';
  let content = '';

  if (type === 'charge.failed') {
    const charge = data.object;
    subject = `Payment Failed: ${charge.amount / 100} ${charge.currency.toUpperCase()}`;
    content = `
<h2>Charge Failed</h2>
<table border="1" cellpadding="5" cellspacing="0" style="border-collapse: collapse;">
  <tr><td><strong>Charge ID:</strong></td><td>${charge.id}</td></tr>
  <tr><td><strong>Amount:</strong></td><td>${charge.amount / 100} ${charge.currency.toUpperCase()}</td></tr>
  <tr><td><strong>Customer:</strong></td><td>${charge.customer || 'Guest'}</td></tr>
  <tr><td><strong>Customer Email:</strong></td><td>${charge.billing_details?.email || 'N/A'}</td></tr>
  <tr><td><strong>Failure Code:</strong></td><td>${charge.failure_code || 'N/A'}</td></tr>
  <tr><td><strong>Failure Message:</strong></td><td>${charge.failure_message || 'N/A'}</td></tr>
  <tr><td><strong>Payment Method:</strong></td><td>${charge.payment_method_details?.type || 'N/A'}</td></tr>
  <tr><td><strong>Created:</strong></td><td>${new Date(charge.created * 1000).toLocaleString()}</td></tr>
  <tr><td><strong>Description:</strong></td><td>${charge.description || 'N/A'}</td></tr>
</table>
    `;
  } else if (type === 'payment_intent.payment_failed') {
    const paymentIntent = data.object;
    subject = `Payment Intent Failed: ${paymentIntent.amount / 100} ${paymentIntent.currency.toUpperCase()}`;
    content = `
<h2>Payment Intent Failed</h2>
<table border="1" cellpadding="5" cellspacing="0" style="border-collapse: collapse;">
  <tr><td><strong>Payment Intent ID:</strong></td><td>${paymentIntent.id}</td></tr>
  <tr><td><strong>Amount:</strong></td><td>${paymentIntent.amount / 100} ${paymentIntent.currency.toUpperCase()}</td></tr>
  <tr><td><strong>Customer:</strong></td><td>${paymentIntent.customer || 'Guest'}</td></tr>
  <tr><td><strong>Status:</strong></td><td>${paymentIntent.status}</td></tr>
  <tr><td><strong>Last Payment Error:</strong></td><td>${paymentIntent.last_payment_error?.message || 'N/A'}</td></tr>
  <tr><td><strong>Payment Method:</strong></td><td>${paymentIntent.payment_method_types?.join(', ') || 'N/A'}</td></tr>
  <tr><td><strong>Created:</strong></td><td>${new Date(paymentIntent.created * 1000).toLocaleString()}</td></tr>
  <tr><td><strong>Description:</strong></td><td>${paymentIntent.description || 'N/A'}</td></tr>
</table>
    `;
  } else if (type === 'invoice.payment_failed') {
    const invoice = data.object;
    subject = `Invoice Payment Failed: ${invoice.amount_due / 100} ${invoice.currency.toUpperCase()}`;
    content = `
<h2>Invoice Payment Failed</h2>
<table border="1" cellpadding="5" cellspacing="0" style="border-collapse: collapse;">
  <tr><td><strong>Invoice ID:</strong></td><td>${invoice.id}</td></tr>
  <tr><td><strong>Invoice Number:</strong></td><td>${invoice.number || 'N/A'}</td></tr>
  <tr><td><strong>Amount Due:</strong></td><td>${invoice.amount_due / 100} ${invoice.currency.toUpperCase()}</td></tr>
  <tr><td><strong>Customer:</strong></td><td>${invoice.customer || 'N/A'}</td></tr>
  <tr><td><strong>Customer Email:</strong></td><td>${invoice.customer_email || 'N/A'}</td></tr>
  <tr><td><strong>Status:</strong></td><td>${invoice.status}</td></tr>
  <tr><td><strong>Due Date:</strong></td><td>${invoice.due_date ? new Date(invoice.due_date * 1000).toLocaleString() : 'N/A'}</td></tr>
  <tr><td><strong>Created:</strong></td><td>${new Date(invoice.created * 1000).toLocaleString()}</td></tr>
  <tr><td><strong>Hosted Invoice URL:</strong></td><td><a href="${invoice.hosted_invoice_url}">${invoice.hosted_invoice_url}</a></td></tr>
</table>
    `;
  }

  return { subject, content };
}

// Send email notification
async function sendFailureNotification(event) {
  try {
    const { subject, content } = formatFailureEmail(event);
    
    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: 'blakeecom02@gmail.com',
      subject,
      html: content
    };

    const result = await transporter.sendMail(mailOptions);
    addLog(`Email sent successfully for ${event.type}: ${result.messageId}`, 'info');
    return true;
  } catch (error) {
    addLog(`Failed to send email: ${error.message}`, 'error');
    return false;
  }
}

// Routes

// Status endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    service: 'Stripe Payment Failure Monitor',
    endpoints: {
      '/': 'Service status and endpoints',
      '/health': 'Health check',
      '/logs': 'View recent logs',
      '/test': 'Test email notification (POST)',
      '/webhook': 'Stripe webhook endpoint (POST)'
    },
    monitoring: [
      'charge.failed',
      'payment_intent.payment_failed', 
      'invoice.payment_failed'
    ],
    notificationEmail: 'blakeecom02@gmail.com'
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// View logs
app.get('/logs', (req, res) => {
  res.json({
    totalLogs: logs.length,
    logs: logs.slice(-20) // Return last 20 logs
  });
});

// Test email functionality
app.post('/test', async (req, res) => {
  try {
    addLog('Manual test triggered', 'info');
    
    // Create a mock failed charge event for testing
    const mockEvent = {
      type: 'charge.failed',
      data: {
        object: {
          id: 'ch_test_123',
          amount: 2500,
          currency: 'usd',
          customer: 'cus_test_123',
          billing_details: {
            email: 'test@example.com'
          },
          failure_code: 'card_declined',
          failure_message: 'Your card was declined.',
          payment_method_details: {
            type: 'card'
          },
          created: Math.floor(Date.now() / 1000),
          description: 'Test payment failure'
        }
      }
    };

    const success = await sendFailureNotification(mockEvent);
    
    if (success) {
      res.json({ 
        status: 'success', 
        message: 'Test email sent successfully to blakeecom02@gmail.com',
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(500).json({ 
        status: 'error', 
        message: 'Failed to send test email',
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    addLog(`Test failed: ${error.message}`, 'error');
    res.status(500).json({ 
      status: 'error', 
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Stripe webhook endpoint
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // Verify webhook signature
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    addLog(`Webhook received: ${event.type}`, 'info');
  } catch (err) {
    addLog(`Webhook signature verification failed: ${err.message}`, 'error');
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle payment failure events
  if (['charge.failed', 'payment_intent.payment_failed', 'invoice.payment_failed'].includes(event.type)) {
    addLog(`Processing payment failure: ${event.type}`, 'info');
    await sendFailureNotification(event);
  }

  res.json({ received: true, type: event.type });
});

// Error handling middleware
app.use((error, req, res, next) => {
  addLog(`Unhandled error: ${error.message}`, 'error');
  res.status(500).json({ 
    status: 'error', 
    message: 'Internal server error',
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  addLog(`Stripe Payment Failure Monitor started on port ${PORT}`, 'info');
});

module.exports = app;
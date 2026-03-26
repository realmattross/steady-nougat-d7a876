const axios = require('axios');

// Telegram Bot Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Email importance scoring criteria
const VIP_SENDERS = [
  'bgv', 'bethnal green ventures',
  'ed shaw', 'john barter',
  'akee', 'meta',
  'lucy heard', 'stillmovingmedia',
  'vouchsafe', 'anna', 'vivian', 'fitterstock'
];

const URGENT_KEYWORDS = [
  'urgent', 'important', 'action required', 'deadline',
  'sha', 'shareholder', 'investor', 'investment',
  'verification', 'verify', 'confirm',
  'meeting', 'call', 'schedule',
  'introduction', 'intro', 'connect'
];

const CONTEXT_KEYWORDS = [
  'day2', 'parkinsons', 'parkinson',
  'nhs', 'health', 'bgv', 'accelerator',
  'pitch', 'deck', 'funding'
];

const TIME_SENSITIVE = [
  'today', 'tomorrow', 'asap',
  'waiting', 'reminder', 'follow up',
  'expiring', 'expire', 'due'
];

const PUSH_SCORE_THRESHOLD = 7;
const PUSH_AGE_THRESHOLD_HOURS = 2;

// Email scoring logic
function scoreEmail(email) {
  let score = 0;
  const reasons = [];
  
  const from = (email.headers?.From || '').toLowerCase();
  const subject = (email.headers?.Subject || '').toLowerCase();
  const snippet = (email.snippet || '').toLowerCase();
  const labels = email.labelIds || [];
  
  if (labels.includes('IMPORTANT')) {
    score += 3;
    reasons.push('Gmail important');
  }
  
  if (VIP_SENDERS.some(vip => from.includes(vip))) {
    score += 3;
    reasons.push('VIP sender');
  }
  
  if (URGENT_KEYWORDS.some(kw => subject.includes(kw))) {
    score += 2;
    reasons.push('Urgent language');
  }
  
  if (CONTEXT_KEYWORDS.some(kw => subject.includes(kw) || snippet.includes(kw))) {
    score += 2;
    reasons.push('Day2-related');
  }
  
  if (TIME_SENSITIVE.some(kw => subject.includes(kw) || snippet.includes(kw))) {
    score += 2;
    reasons.push('Time-sensitive');
  }
  
  if (labels.includes('INBOX')) {
    score += 1;
    reasons.push('Primary inbox');
  }
  
  if (labels.includes('CATEGORY_PROMOTIONS')) {
    score -= 2;
  }
  
  return {
    score: Math.max(0, Math.min(10, score)),
    reasons
  };
}

// Check for important emails
async function checkImportantEmails() {
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: 'Call Gmail:gmail_search_messages with q="is:unread" and maxResults=50. Return ONLY raw JSON with no preamble.'
        }]
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01'
        }
      }
    );

    // Extract emails from Claude response
    const textBlock = response.data.content.find(b => b.type === 'text');
    if (!textBlock) return [];
    
    const gmailData = JSON.parse(textBlock.text);
    const emails = gmailData.messages || [];
    
    const importantEmails = [];
    const now = Date.now();
    
    for (const email of emails) {
      const ageHours = (now - parseInt(email.internalDate)) / (1000 * 60 * 60);
      const { score, reasons } = scoreEmail(email);
      
      if (score >= PUSH_SCORE_THRESHOLD && ageHours >= PUSH_AGE_THRESHOLD_HOURS) {
        importantEmails.push({
          from: email.headers?.From || 'Unknown',
          subject: email.headers?.Subject || '(No subject)',
          snippet: email.snippet?.substring(0, 150),
          score,
          reasons,
          ageHours: ageHours.toFixed(1)
        });
      }
    }
    
    return importantEmails;
  } catch (error) {
    console.error('Email check failed:', error);
    return [];
  }
}

// Send message to Telegram
async function sendToTelegram(message) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      }
    );
    return true;
  } catch (error) {
    console.error('Telegram send failed:', error);
    return false;
  }
}

// Main handler
exports.handler = async (event) => {
  // Handle OPTIONS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  // Only accept POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { message, command } = JSON.parse(event.body);

    // Handle email check command
    if (command === 'check_emails') {
      const importantEmails = await checkImportantEmails();
      
      if (importantEmails.length === 0) {
        await sendToTelegram('✅ No important unread emails');
      } else {
        let msg = `🚨 *${importantEmails.length} Important Email${importantEmails.length > 1 ? 's' : ''}*\n\n`;
        
        for (const email of importantEmails.slice(0, 5)) { // Max 5 at a time
          msg += `*[${email.score}/10]* ${email.from}\n`;
          msg += `*Subject:* ${email.subject}\n`;
          msg += `${email.snippet}...\n`;
          msg += `_${email.reasons.join(', ')} • ${email.ageHours}h old_\n\n`;
        }
        
        if (importantEmails.length > 5) {
          msg += `_...and ${importantEmails.length - 5} more_`;
        }
        
        await sendToTelegram(msg);
      }
      
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, count: importantEmails.length })
      };
    }

    // Handle regular message send
    if (message) {
      await sendToTelegram(message);
      
      return {
        statusCode: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ success: true })
      };
    }

    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'No message or command provided' })
    };

  } catch (error) {
    console.error('Handler error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};

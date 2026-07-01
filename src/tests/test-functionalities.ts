import { LearnDashService } from '../services/LearnDashService.js';
import { LLMService } from '../services/LLMService.js';
import { parseCommand } from '../utils/commandParser.js';
import { CONFIG } from '../config/constants.js';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'path';

// Simple colored console logging helpers
const log = {
  section: (title: string) => console.log(`\n=================== 🧪 TEST: ${title} ===================`),
  success: (msg: string) => console.log(`✅ SUCCESS: ${msg}`),
  error: (msg: string) => console.error(`❌ ERROR: ${msg}`),
  info: (msg: string) => console.log(`ℹ️ INFO: ${msg}`),
};

async function testLearnDashIntegration() {
  log.section('LearnDash JWT Authentication & Connectivity');
  const service = new LearnDashService();
  
  try {
    log.info(`Connecting to LearnDash at: ${CONFIG.LEARNDASH.BASE_URL}`);
    const token = await service.authenticate();
    log.success('LearnDash Authentication successful!');
    log.info(`Token starts with: ${token.substring(0, 15)}...`);
    
    const coursesUrl = `${CONFIG.LEARNDASH.BASE_URL}/wp-json/ldlms/v2/sfwd-courses?per_page=1`;
    log.info(`Querying LearnDash courses to test GET permissions: ${coursesUrl}`);
    
    const response = await fetch(coursesUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      }
    });

    if (response.ok) {
      const courses = await response.json() as any[];
      log.success(`Fetched courses. Found ${courses.length} courses.`);
      if (courses.length > 0) {
        log.info(`First course ID: ${courses[0].id}, Title: ${courses[0].title.rendered}`);
      }
    } else {
      log.error(`Courses query failed with status: ${response.status}`);
    }
  } catch (err: any) {
    log.error(`LearnDash Integration failed: ${err.message}`);
  }
}

async function testLLMIntegration() {
  log.section('Gemini LLM Essay Evaluation');
  const llm = new LLMService();

  const prompt = 'Explain how gravity holds planets in orbit around the Sun.';
  const rubric = 'The answer must mention mass, gravity force, and orbital inertia/velocity.';
  const studentAnswer = 'The sun has a very high mass. This mass creates a gravitational pull that acts on the planets. The planets want to fly off into space because of their speed, but gravity keeps pulling them in, causing them to go in a circle around the sun.';

  log.info(`Sending sample essay submission to Gemini model (${CONFIG.GEMINI.MODEL_NAME})...`);
  
  try {
    const result = await llm.evaluateEssay(prompt, rubric, studentAnswer);
    log.success('Gemini LLM successfully graded the essay!');
    console.log('\n--- LLM Response JSON ---');
    console.log(JSON.stringify(result, null, 2));
    console.log('-------------------------\n');
  } catch (err: any) {
    log.error(`LLM Integration failed: ${err.message}`);
  }
}

async function testWhatsAppIntegration(): Promise<void> {
  log.section('WhatsApp Group Creation & Admin Setup');
  
  return new Promise(async (resolve) => {
    const sessionDir = path.join(process.cwd(), 'whatsapp_session');
    const { state } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    log.info('Connecting to WhatsApp using stored session...');
    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      defaultQueryTimeoutMs: 60000,
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      
      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        // Don't error out if connection closed gracefully at the end of the test
        if (statusCode !== undefined) {
          log.error(`WhatsApp connection closed (Status: ${statusCode}). skipping WhatsApp test.`);
        }
        resolve();
      } else if (connection === 'open') {
        log.success('WhatsApp connection successfully opened!');
        
        try {
          const botJid = CONFIG.BOT.PHONE_NUMBER.includes('@') 
            ? CONFIG.BOT.PHONE_NUMBER 
            : `${CONFIG.BOT.PHONE_NUMBER}@s.whatsapp.net`;
            
          log.info('Triggering test group creation...');
          const subject = 'Test Class Bot Group';
          
          // Create group with the bot itself
          const response = await sock.groupCreate(subject, [botJid]);
          log.success(`Created WhatsApp group successfully! Group ID: ${response.id}`);

          log.info('Sending welcome message to the group...');
          await sock.sendMessage(response.id, {
            text: '🤖 Welcome! This is a test message in the newly created bot orchestration group.'
          });
          log.success('Sent message successfully!');

        } catch (err: any) {
          log.error(`WhatsApp group actions failed: ${err.message}`);
        } finally {
          // Close the socket connection at the end of the test
          sock.end(undefined);
          resolve();
        }
      }
    });
  });
}

async function runAllTests() {
  console.log('🚀 STARTING INTEGRATION FUNCTIONALITY TESTS 🚀');
  
  // 1. LearnDash Auth and course fetch
  await testLearnDashIntegration();
  
  // 2. Gemini LLM Grading
  await testLLMIntegration();
  
  // 3. WhatsApp Group Actions
  await testWhatsAppIntegration();
  
  console.log('\n🏁 Tests Completed. Exiting.');
  process.exit(0);
}

runAllTests().catch(err => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});

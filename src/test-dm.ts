import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'path';
import { CONFIG } from './config/constants.js';

let isPairingCodeRequested = false;

async function runDirectTest() {
  const sessionDir = path.join(process.cwd(), 'whatsapp_session');
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  console.log('Fetching latest WhatsApp Web API version...');
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Using WhatsApp Web version: ${version.join('.')}, isLatest: ${isLatest}`);

  console.log('Connecting to WhatsApp using Phone Number Pairing...');
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    defaultQueryTimeoutMs: 90000,
    connectTimeoutMs: 90000,
    keepAliveIntervalMs: 10000, // Frequent keepalives to prevent VPS network drops
  });

  sock.ev.on('creds.update', saveCreds);

  // Request pairing code if not registered and not already requested in this session
  if (!sock.authState.creds.registered && !isPairingCodeRequested) {
    isPairingCodeRequested = true;
    const phoneNumber = CONFIG.BOT.PHONE_NUMBER.replace(/[^0-9]/g, '');
    console.log(`Requesting WhatsApp pairing code for phone number: ${phoneNumber}...`);
    
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log('\n=======================================');
        console.log(`🔑 YOUR WHATSAPP PAIRING CODE: ${code}`);
        console.log('=======================================\n');
        console.log('Instructions:');
        console.log('1. Open WhatsApp on your phone.');
        console.log('2. Go to Settings -> Linked Devices -> Link a Device.');
        console.log('3. Select "Link with phone number instead".');
        console.log(`4. Enter the 8-digit code above: ${code}\n`);
      } catch (err) {
        console.error('Failed to request pairing code:', err);
        isPairingCodeRequested = false; // Reset on failure so it can retry
      }
    }, 4000);
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    
    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log(`Connection closed. Status code: ${statusCode}. Reconnecting: ${shouldReconnect}`);
      
      // If the connection drops, reset pairing code request state so we can generate a new one on reconnect
      isPairingCodeRequested = false;
      
      if (shouldReconnect) {
        // Add a slight delay before reconnecting to prevent thrashing
        setTimeout(() => {
          runDirectTest();
        }, 5000);
      }
    } else if (connection === 'open') {
      console.log('Connection successfully opened!');
      
      // Target number is BOT_PHONE_NUMBER from env, formatted as JID
      const targetJid = CONFIG.BOT.PHONE_NUMBER.includes('@') 
        ? CONFIG.BOT.PHONE_NUMBER 
        : `${CONFIG.BOT.PHONE_NUMBER}@s.whatsapp.net`;
      
      console.log(`Sending test message to: ${targetJid}`);
      
      try {
        await sock.sendMessage(targetJid, {
          text: '👋 Hello! This is a test message from your Revision Workshop Bot (v0.0.1).\n\nConnection is working perfectly! 🚀'
        });
        console.log('Test message sent successfully!');
        
        // Wait 3 seconds and exit
        setTimeout(() => {
          console.log('Exiting test script.');
          process.exit(0);
        }, 3000);
      } catch (err) {
        console.error('Failed to send test message:', err);
      }
    }
  });
}

runDirectTest().catch(err => {
  console.error('Error running test script:', err);
});

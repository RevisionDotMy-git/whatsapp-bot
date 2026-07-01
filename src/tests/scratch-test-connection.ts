import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'path';

const log = {
  section: (title: string) => console.log(`\n=================== 🧪 ${title} ===================`),
  success: (msg: string) => console.log(`✅ SUCCESS: ${msg}`),
  error: (msg: string) => console.error(`❌ ERROR: ${msg}`),
  info: (msg: string) => console.log(`ℹ️ INFO: ${msg}`),
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  log.section('WhatsApp Connection & Group Setup Test');

  const studentJid = '248030116757531@lid';
  const teacherJid = '60122082435@s.whatsapp.net';
  const selfJid = '601110854085@s.whatsapp.net';

  // Connect to WhatsApp
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
      log.error(`WhatsApp connection closed (Status Code: ${statusCode})`);
      process.exit(1);
    } else if (connection === 'open') {
      log.success('WhatsApp connection successfully opened!');
      
      try {
        // 1. Send DMs
        log.section('Task 1: Sending DMs');

        log.info(`Sending DM to self (${selfJid})...`);
        try {
          await sock.sendMessage(selfJid, { text: '🤖 Hello from the WhatsApp bot to itself!' });
          log.success('Sent DM to self successfully!');
        } catch (err: any) {
          log.error(`Failed sending DM to self: ${err.message}`);
        }

        log.info(`Sending DM to student (${studentJid})...`);
        try {
          await sock.sendMessage(studentJid, { text: '👋 Hello Lynxx! This is a test DM from the WhatsApp online class assistant bot.' });
          log.success('Sent DM to student successfully!');
        } catch (err: any) {
          log.error(`Failed sending DM to student: ${err.message}`);
        }

        log.info(`Sending DM to teacher (${teacherJid})...`);
        try {
          await sock.sendMessage(teacherJid, { text: '👋 Hello Cikgu Kwee! This is a test DM from the WhatsApp online class assistant bot.' });
          log.success('Sent DM to teacher successfully!');
        } catch (err: any) {
          log.error(`Failed sending DM to teacher: ${err.message}`);
        }

        // Wait 5 seconds
        await sleep(5000);

        // 2 & 3. Create Groups and Add Participants
        log.section('Task 2 & 3: Group Creation & Participant Addition');

        const groupsToCreate = [
          {
            name: 'SPM Physics',
            participants: [teacherJid, studentJid]
          },
          {
            name: 'SPM Chemistry',
            participants: [teacherJid]
          },
          {
            name: 'SPM Courses',
            participants: [teacherJid, studentJid]
          }
        ];

        for (const g of groupsToCreate) {
          log.info(`Creating group: "${g.name}" with participants: ${g.participants.join(', ')}...`);
          let groupMeta;
          let created = false;

          try {
            groupMeta = await sock.groupCreate(g.name, g.participants);
            log.success(`Group "${g.name}" created successfully! JID: ${groupMeta.id}`);
            created = true;
          } catch (err: any) {
            log.error(`Failed to create group "${g.name}" with all participants: ${err.message}`);
            
            // Fallback to student only if it failed due to reachout restrictions
            if (g.participants.includes(studentJid)) {
              log.info(`Attempting fallback: create group with student only: ${studentJid}...`);
              try {
                groupMeta = await sock.groupCreate(g.name, [studentJid]);
                log.success(`Group "${g.name}" created successfully with student only! JID: ${groupMeta.id}`);
                created = true;
                
                // Try adding teacher now
                log.info(`Attempting to add teacher Kwee (${teacherJid}) to group...`);
                try {
                  await sock.groupParticipantsUpdate(groupMeta.id, [teacherJid], 'add');
                  log.success('Successfully added teacher Kwee to group!');
                } catch (addErr: any) {
                  log.error(`Failed adding teacher Kwee: ${addErr.message}`);
                }
              } catch (studentErr: any) {
                log.error(`Fallback failed: create group with student: ${studentErr.message}`);
              }
            }
          }

          if (created && groupMeta) {
            // Promote teacher to Admin if possible
            log.info(`Attempting to promote teacher Kwee (${teacherJid}) to Admin...`);
            try {
              await sock.groupParticipantsUpdate(groupMeta.id, [teacherJid], 'promote');
              log.success(`Kwee promoted to admin in "${g.name}"!`);
            } catch (promoteErr: any) {
              log.error(`Failed to promote Kwee to admin: ${promoteErr.message}`);
            }

            // Send welcome message
            log.info(`Sending welcome message to group "${g.name}"...`);
            try {
              await sock.sendMessage(groupMeta.id, {
                text: `🤖 Welcome to *${g.name}*!\n\n👩‍🏫 Teacher Admin: *Kwee*\n👤 Student: *Lynxx*\n\nThis group has been automatically created and configured.`
              });
              log.success(`Sent welcome message to group "${g.name}"!`);
            } catch (sendErr: any) {
              log.error(`Failed to send welcome message: ${sendErr.message}`);
            }
          }

          // Delay to respect rate limits
          log.info('Waiting 15 seconds before processing next group to respect WhatsApp rate limits...');
          await sleep(15000);
        }

        log.success('All group creation tasks completed!');
      } catch (err: any) {
        log.error(`Fatal during execution: ${err.message}`);
      } finally {
        sock.end(undefined);
        process.exit(0);
      }
    }
  });
}

run().catch(err => {
  log.error(`Fatal execution error: ${err.message}`);
  process.exit(1);
});

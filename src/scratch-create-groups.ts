import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  WASocket
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'path';
import fs from 'fs';
import { parseCsvString } from './utils/csvParser.js';

const log = {
  section: (title: string) => console.log(`\n=================== 🧪 ${title} ===================`),
  success: (msg: string) => console.log(`✅ SUCCESS: ${msg}`),
  error: (msg: string) => console.error(`❌ ERROR: ${msg}`),
  info: (msg: string) => console.log(`ℹ️ INFO: ${msg}`),
};

async function run() {
  log.section('WhatsApp Group Creator & Role Assigner');

  // 1. Read and parse the CSV file
  const csvPath = path.join(process.cwd(), 'src', 'tests', 'test csv - Sheet1.csv');
  if (!fs.existsSync(csvPath)) {
    log.error(`CSV file not found at: ${csvPath}`);
    process.exit(1);
  }

  const csvContent = fs.readFileSync(csvPath, 'utf8');
  log.info('Parsing CSV content...');
  const rows = parseCsvString(csvContent);
  console.log('Parsed Rows:', JSON.stringify(rows, null, 2));

  // Identify teacher and students
  const kwee = rows.find(r => r.originalName.toLowerCase() === 'kwee');
  const lynxx = rows.find(r => r.originalName.toLowerCase() === 'lynxx');

  if (!kwee) {
    log.error('Could not find Kwee in the CSV roster.');
    process.exit(1);
  }
  if (!kwee.isValid) {
    log.error(`Kwee row has invalid phone format: ${kwee.error}`);
    process.exit(1);
  }
  if (!lynxx) {
    log.error('Could not find Lynxx in the CSV roster.');
    process.exit(1);
  }
  if (!lynxx.isValid) {
    log.error(`Lynxx row has invalid phone format: ${lynxx.error}`);
    process.exit(1);
  }

  const teacherJid = `${kwee.phone}@s.whatsapp.net`;
  const studentJid = '248030116757531@lid';

  log.info(`Teacher (Kwee) JID: ${teacherJid}`);
  log.info(`Student (Lynxx) JID: ${studentJid}`);

  // 2. Connect to WhatsApp
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
        // Send a private hello message to teacher (Kwee) and student (Lynxx)
        log.info(`Sending hello message to teacher ${teacherJid}...`);
        await sock.sendMessage(teacherJid, {
          text: '👋 Hello Cikgu Kwee! This is a test DM from the WhatsApp online class assistant bot.'
        });
        log.success(`Sent hello to teacher!`);

        log.info(`Sending hello message to student ${studentJid}...`);
        await sock.sendMessage(studentJid, {
          text: '👋 Hello Lynxx! This is a test DM from the WhatsApp online class assistant bot.'
        });
        log.success(`Sent hello to student!`);

        // Group definitions: Create group initially with teacher (valid JID)
        const groupsToCreate = [
          {
            name: 'SPM Physics',
            students: [studentJid]
          },
          {
            name: 'SPM Chemistry',
            students: []
          },
          {
            name: 'SPM Courses',
            students: [studentJid]
          }
        ];

        for (const g of groupsToCreate) {
          log.info(`Creating group: "${g.name}"...`);
          
          let groupMeta;
          let teacherAdded = false;
          let createdWithStudent = false;

          try {
            // Create Group with teacher initially
            log.info(`Attempting to create group with teacher: ${teacherJid}...`);
            groupMeta = await sock.groupCreate(g.name, [teacherJid]);
            log.success(`Group "${g.name}" created successfully with teacher! JID: ${groupMeta.id}`);
            teacherAdded = true;
          } catch (err: any) {
            log.error(`Failed to create group "${g.name}" with teacher: ${err.message}`);
            log.info(`Attempting fallback: create group with student: ${studentJid}...`);
            try {
              groupMeta = await sock.groupCreate(g.name, [studentJid]);
              log.success(`Group "${g.name}" created successfully with student! JID: ${groupMeta.id}`);
              createdWithStudent = true;
            } catch (studentErr: any) {
              log.error(`Failed fallback: create group "${g.name}" with student: ${studentErr.message}`);
              continue;
            }
          }

          if (groupMeta) {
            // Try to add teacher if not already added
            if (!teacherAdded) {
              log.info(`Attempting to add teacher Kwee (${teacherJid}) to group "${g.name}"...`);
              try {
                await sock.groupParticipantsUpdate(groupMeta.id, [teacherJid], 'add');
                log.success(`Successfully added teacher Kwee to group "${g.name}"!`);
                teacherAdded = true;
              } catch (addErr: any) {
                log.error(`Failed to add teacher Kwee: ${addErr.message} (Teacher must message the bot first).`);
              }
            }

            // Promote teacher to Admin if in group
            if (teacherAdded) {
              log.info(`Promoting teacher Kwee (${teacherJid}) to Admin in group "${g.name}"...`);
              try {
                await sock.groupParticipantsUpdate(groupMeta.id, [teacherJid], 'promote');
                log.success(`Kwee successfully promoted to admin in "${g.name}"!`);
              } catch (promoteErr: any) {
                log.error(`Failed to promote Kwee to admin: ${promoteErr.message}`);
              }
            }

            // Add other students
            for (const student of g.students) {
              if (createdWithStudent && student === studentJid) {
                // Already added during creation
                continue;
              }
              log.info(`Attempting to add student ${student} to group "${g.name}"...`);
              try {
                await sock.groupParticipantsUpdate(groupMeta.id, [student], 'add');
                log.success(`Successfully added student ${student} to "${g.name}"!`);
              } catch (addStudentErr: any) {
                log.error(`Failed to add student ${student} to "${g.name}": ${addStudentErr.message}`);
              }
            }

            // Send welcome message
            try {
              await sock.sendMessage(groupMeta.id, {
                text: `🤖 Welcome to *${g.name}*!\n\n👩‍🏫 Teacher Admin: *Kwee*\n👤 Student: *Lynxx*\n\nThis group has been automatically created and configured.`
              });
              log.success(`Sent welcome message to group "${g.name}".`);
            } catch (sendErr: any) {
              log.error(`Failed to send welcome message: ${sendErr.message}`);
            }
          }

          // Delay to respect rate limits
          log.info('Waiting 10 seconds before processing next group to respect WhatsApp rate limits...');
          await new Promise(resolve => setTimeout(resolve, 10000));
        }

        log.success('All group creation tasks processed!');
      } catch (err: any) {
        log.error(`Failed during group orchestration: ${err.message}`);
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

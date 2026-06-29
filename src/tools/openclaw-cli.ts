import http from 'http';

const API_BASE = process.env.API_BASE || 'http://localhost:4000';

function post(path: string, body: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE);
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      }
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(responseBody));
        } catch {
          resolve({ error: responseBody });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'GET',
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(responseBody));
        } catch {
          resolve({ error: responseBody });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function del(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'DELETE',
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(responseBody));
        } catch {
          resolve({ error: responseBody });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  const args = process.argv.slice(2);
  const action = args[0];

  if (!action) {
    console.log(`
Usage: npx tsx src/tools/openclaw-cli.ts <action> [arguments]

Actions:
  sync                                 Sync LearnDash course cache
  class-list                           List all classes
  class-create <subject> <courseId> <day> <time> <teacherPhone> <teacherName>
  class-delete <workshopId>
  homework-assign <workshopId> <lessonId> [dueDateText]
  homework-list <workshopId>
  homework-delete <workshopId> <lessonId>
  student-invite <role: student|teacher> <phone> <name>
  student-add <studentPhone> <workshopId>
  student-list <workshopId>
  student-remove <role: student|teacher> <phone> [subject]
  report <workshopId>                  Retrieve report for class
  send-message <phone_or_jid> <message_text>
`);
    return;
  }

  try {
    switch (action) {
      case 'sync': {
        console.log('Triggering LearnDash cache sync...');
        const res = await post('/api/learndash/sync', {});
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case 'class-list': {
        const res = await get('/api/workshops');
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case 'class-create': {
        const [subject, courseId, day, time, teacherPhone, teacherName] = args.slice(1);
        if (!subject || !courseId || !day || !time || !teacherPhone || !teacherName) {
          console.error('Usage: class-create <subject> <courseId> <day> <time> <teacherPhone> <teacherName>');
          process.exit(1);
        }
        const res = await post('/api/workshop', {
          subject,
          courseId: parseInt(courseId, 10),
          classDayOfWeek: parseInt(day, 10),
          classTime: time,
          teacherPhone,
          teacherName,
        });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case 'class-delete': {
        const id = args[1];
        if (!id) {
          console.error('Usage: class-delete <workshopId>');
          process.exit(1);
        }
        const res = await del(`/api/workshops/${id}`);
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case 'homework-assign': {
        const [workshopId, lessonId, dueDateText] = args.slice(1);
        if (!workshopId || !lessonId) {
          console.error('Usage: homework-assign <workshopId> <lessonId> [dueDateText]');
          process.exit(1);
        }

        let parsedDate = new Date();
        if (dueDateText) {
          const textLower = dueDateText.toLowerCase();
          if (textLower === 'tomorrow') {
            parsedDate.setDate(parsedDate.getDate() + 1);
          } else if (textLower === 'next week') {
            parsedDate.setDate(parsedDate.getDate() + 7);
          } else if (textLower.endsWith('days') || textLower.endsWith('day')) {
            const days = parseInt(dueDateText, 10);
            if (!isNaN(days)) {
              parsedDate.setDate(parsedDate.getDate() + days);
            }
          } else {
            const absDate = new Date(dueDateText);
            if (!isNaN(absDate.getTime())) {
              parsedDate = absDate;
            } else {
              parsedDate.setDate(parsedDate.getDate() + 7);
            }
          }
        } else {
          parsedDate.setDate(parsedDate.getDate() + 7);
        }

        const res = await post(`/api/workshops/${workshopId}/homeworks`, {
          lessonId: parseInt(lessonId, 10),
          dueDate: parsedDate.toISOString(),
        });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case 'homework-list': {
        const workshopId = args[1];
        if (!workshopId) {
          console.error('Usage: homework-list <workshopId>');
          process.exit(1);
        }
        const res = await get(`/api/workshops/${workshopId}/homeworks`);
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case 'homework-delete': {
        const [workshopId, lessonId] = args.slice(1);
        if (!workshopId || !lessonId) {
          console.error('Usage: homework-delete <workshopId> <lessonId>');
          process.exit(1);
        }
        const res = await del(`/api/workshops/${workshopId}/homeworks/${lessonId}`);
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case 'student-invite': {
        const [role, phoneNumber, name] = args.slice(1);
        if (!role || !phoneNumber || !name) {
          console.error('Usage: student-invite <role: student|teacher> <phone> <name>');
          process.exit(1);
        }
        const res = await post('/api/invite', { role, phoneNumber, name });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case 'student-add': {
        const [studentPhone, workshopId] = args.slice(1);
        if (!studentPhone || !workshopId) {
          console.error('Usage: student-add <studentPhone> <workshopId>');
          process.exit(1);
        }
        const res = await post(`/api/workshop/${workshopId}/student`, {
          phoneNumber: studentPhone,
          name: `Student-${studentPhone.replace(/\D/g, '')}`,
          learndashId: -Math.floor(Date.now() / 1000)
        });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case 'student-list': {
        const workshopId = args[1];
        if (!workshopId) {
          console.error('Usage: student-list <workshopId>');
          process.exit(1);
        }
        const res = await get(`/api/workshops/${workshopId}/students`);
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case 'student-remove': {
        const [role, phoneNumber, subject] = args.slice(1);
        if (!role || !phoneNumber) {
          console.error('Usage: student-remove <role: student|teacher> <phone> [subject]');
          process.exit(1);
        }
        const res = await post('/api/remove', { role, phoneNumber, subject });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case 'report': {
        const workshopId = args[1];
        if (!workshopId) {
          console.error('Usage: report <workshopId>');
          process.exit(1);
        }
        const res = await get(`/api/workshops/${workshopId}/report`);
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case 'send-message': {
        const jid = args[1];
        const text = args.slice(2).join(' ');
        if (!jid || !text) {
          console.error('Usage: send-message <phone_or_jid> <message_text>');
          process.exit(1);
        }
        const res = await post('/api/send-message', { jid, text });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      default: {
        console.error(`Unknown action: ${action}`);
        process.exit(1);
      }
    }
  } catch (err: any) {
    console.error('Error executing CLI command:', err.message);
    process.exit(1);
  }
}

run();

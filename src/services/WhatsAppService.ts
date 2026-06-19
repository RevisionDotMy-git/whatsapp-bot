import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  proto,
  downloadContentFromMessage
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'path';
import { IWhatsAppClient, IncomingMessage, DocumentAttachment } from '../interfaces/IWhatsAppClient.js';
import { logAudit } from './db.js';

export class WhatsAppService implements IWhatsAppClient {
  private sock: WASocket | null = null;
  private messageCallbacks: ((msg: IncomingMessage) => Promise<void> | void)[] = [];
  private participantCallbacks: ((event: { groupJid: string; participants: string[]; action: 'add' | 'remove' }) => Promise<void> | void)[] = [];

  async connect(): Promise<void> {
    const sessionDir = path.join(process.cwd(), 'whatsapp_session');
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      defaultQueryTimeoutMs: 60000,
    });

    this.sock = sock;

    // Listen for credentials updates to persist login
    sock.ev.on('creds.update', saveCreds);

    // Listen for connection states
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      
      if (connection === 'close') {
        const shouldReconnect =
          (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
        
        await logAudit(
          'WARN',
          'WHATSAPP_CONNECTION_CLOSE',
          `WhatsApp connection closed. Reason: ${lastDisconnect?.error?.message || 'Unknown'}. Reconnecting: ${shouldReconnect}`
        );

        if (shouldReconnect) {
          this.connect();
        }
      } else if (connection === 'open') {
        await logAudit('INFO', 'WHATSAPP_CONNECTION_OPEN', 'WhatsApp Bot successfully connected to server.');
      }
    });

    // Listen for group participant changes
    sock.ev.on('group-participants.update', async (update) => {
      const { id: groupJid, participants, action } = update;
      if (action === 'add' || action === 'remove') {
        for (const callback of this.participantCallbacks) {
          try {
            await callback({ groupJid, participants, action });
          } catch (err: any) {
            await logAudit(
              'ERROR',
              'WHATSAPP_PARTICIPANT_CALLBACK_ERROR',
              `Error in participant update callback: ${err.message}`
            );
          }
        }
      }
    });

    // Listen for incoming messages
    sock.ev.on('messages.upsert', async (m) => {
      if (m.type === 'notify') {
        for (const msg of m.messages) {
          // Ignore self messages to avoid infinite loops
          if (msg.key.fromMe) continue;

          const senderJid = msg.key.participant || msg.key.remoteJid || '';
          const chatJid = msg.key.remoteJid || '';
          const text = msg.message?.conversation || 
                       msg.message?.extendedTextMessage?.text || 
                       '';

          // Extract document if present
          const docMessage = msg.message?.documentMessage;
          if (!senderJid) continue;
          if (!text && !docMessage) continue;

          let documentAttachment: DocumentAttachment | undefined;
          if (docMessage) {
            documentAttachment = {
              fileName: docMessage.fileName || '',
              mimetype: docMessage.mimetype || '',
              mediaKey: docMessage.mediaKey instanceof Uint8Array ? docMessage.mediaKey : new Uint8Array(docMessage.mediaKey || []),
              url: docMessage.url || '',
              fileLength: typeof docMessage.fileLength === 'number' ? docMessage.fileLength : Number(docMessage.fileLength || 0),
              directPath: docMessage.directPath || '',
            };
          }

          const isGroup = chatJid.endsWith('@g.us');

          const incoming: IncomingMessage = {
            senderJid,
            chatJid,
            text: text || docMessage?.caption || docMessage?.fileName || '',
            isGroup,
            timestamp: typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : Number(msg.messageTimestamp),
            document: documentAttachment,
          };

          // Trigger registered callbacks
          for (const callback of this.messageCallbacks) {
            try {
              await callback(incoming);
            } catch (err: any) {
              await logAudit('ERROR', 'WHATSAPP_CALLBACK_ERROR', `Error in message processing callback: ${err.message}`);
            }
          }
        }
      }
    });
  }

  async createGroup(subject: string, participants: string[]): Promise<string> {
    if (!this.sock) throw new Error('WhatsApp client not initialized');
    
    try {
      const response = await this.sock.groupCreate(subject, participants);
      await logAudit(
        'INFO',
        'WHATSAPP_GROUP_CREATE',
        `Created group: ${subject} with ID: ${response.id}. Participants: ${participants.join(', ')}`
      );
      return response.id;
    } catch (err: any) {
      await logAudit('ERROR', 'WHATSAPP_GROUP_CREATE_FAILED', `Failed to create group ${subject}: ${err.message}`);
      throw err;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp client not initialized');

    try {
      await this.sock.sendMessage(jid, { text });
    } catch (err: any) {
      await logAudit('ERROR', 'WHATSAPP_SEND_MSG_FAILED', `Failed to send message to ${jid}: ${err.message}`);
      throw err;
    }
  }

  async addParticipants(groupJid: string, participants: string[]): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp client not initialized');
    try {
      await this.sock.groupParticipantsUpdate(groupJid, participants, 'add');
      await logAudit('INFO', 'WHATSAPP_PARTICIPANT_ADD', `Added users to ${groupJid}: ${participants.join(', ')}`);
    } catch (err: any) {
      await logAudit('ERROR', 'WHATSAPP_PARTICIPANT_ADD_FAILED', `Failed to add users to ${groupJid}: ${err.message}`);
      throw err;
    }
  }

  async removeParticipants(groupJid: string, participants: string[]): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp client not initialized');
    try {
      await this.sock.groupParticipantsUpdate(groupJid, participants, 'remove');
      await logAudit('INFO', 'WHATSAPP_PARTICIPANT_REMOVE', `Removed users from ${groupJid}: ${participants.join(', ')}`);
    } catch (err: any) {
      await logAudit('ERROR', 'WHATSAPP_PARTICIPANT_REMOVE_FAILED', `Failed to remove users from ${groupJid}: ${err.message}`);
      throw err;
    }
  }

  async promoteAdmins(groupJid: string, participants: string[]): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp client not initialized');
    try {
      await this.sock.groupParticipantsUpdate(groupJid, participants, 'promote');
      await logAudit('INFO', 'WHATSAPP_ADMIN_PROMOTE', `Promoted users to admin in ${groupJid}: ${participants.join(', ')}`);
    } catch (err: any) {
      await logAudit('ERROR', 'WHATSAPP_ADMIN_PROMOTE_FAILED', `Failed to promote users in ${groupJid}: ${err.message}`);
      throw err;
    }
  }

  onMessage(callback: (message: IncomingMessage) => Promise<void> | void): void {
    this.messageCallbacks.push(callback);
  }

  async getGroups(): Promise<{ id: string; subject: string }[]> {
    if (!this.sock) throw new Error('WhatsApp client not initialized');
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      return Object.values(groups).map((g) => ({
        id: g.id,
        subject: g.subject,
      }));
    } catch (err: any) {
      await logAudit('ERROR', 'WHATSAPP_GET_GROUPS_FAILED', `Failed to fetch groups: ${err.message}`);
      throw err;
    }
  }

  async downloadDocument(attachment: DocumentAttachment): Promise<Buffer> {
    try {
      const stream = await downloadContentFromMessage(
        {
          url: attachment.url,
          mediaKey: attachment.mediaKey,
          directPath: attachment.directPath,
        },
        'document'
      );
      const buffer: any[] = [];
      for await (const chunk of stream) {
        buffer.push(chunk);
      }
      return Buffer.concat(buffer);
    } catch (err: any) {
      await logAudit('ERROR', 'WHATSAPP_DOWNLOAD_FAIL', `Failed to download document: ${err.message}`);
      throw err;
    }
  }

  onGroupParticipantUpdate(callback: (event: { groupJid: string; participants: string[]; action: 'add' | 'remove' }) => Promise<void> | void): void {
    this.participantCallbacks.push(callback);
  }
}

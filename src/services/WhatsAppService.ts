import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  proto
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'path';
import { IWhatsAppClient, IncomingMessage } from '../interfaces/IWhatsAppClient.js';
import { logAudit } from './db.js';

export class WhatsAppService implements IWhatsAppClient {
  private sock: WASocket | null = null;
  private messageCallbacks: ((msg: IncomingMessage) => Promise<void> | void)[] = [];

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

          if (!text || !senderJid) continue;

          const isGroup = chatJid.endsWith('@g.us');

          const incoming: IncomingMessage = {
            senderJid,
            chatJid,
            text,
            isGroup,
            timestamp: typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : Number(msg.messageTimestamp),
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
}

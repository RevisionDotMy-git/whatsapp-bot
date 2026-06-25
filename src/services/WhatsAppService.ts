import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  proto,
  downloadContentFromMessage,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'path';
import fs from 'fs';
import qrcode from 'qrcode-terminal';
import { IWhatsAppClient, IncomingMessage, DocumentAttachment } from '../interfaces/IWhatsAppClient.js';
import { logAudit } from './db.js';
import { CONFIG } from '../config/constants.js';

export class WhatsAppService implements IWhatsAppClient {
  private sock: WASocket | null = null;
  private isReady = false;
  private messageCallbacks: ((msg: IncomingMessage) => Promise<void> | void)[] = [];
  private participantCallbacks: ((event: { groupJid: string; participants: string[]; action: 'add' | 'remove' }) => Promise<void> | void)[] = [];
  private connectionOpenCallbacks: (() => Promise<void> | void)[] = [];

  async connect(): Promise<void> {
    // If there is an existing socket, end it and remove its listeners
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners('connection.update');
        this.sock.ev.removeAllListeners('creds.update');
        this.sock.ev.removeAllListeners('messages.upsert');
        this.sock.ev.removeAllListeners('group-participants.update');
        this.sock.end(undefined);
      } catch (err) {
        console.error('Failed to clean up old socket:', err);
      }
      this.sock = null;
      this.isReady = false;
    }

    const sessionDir = path.join(process.cwd(), 'whatsapp_session');
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      defaultQueryTimeoutMs: CONFIG.WHATSAPP.DEFAULT_QUERY_TIMEOUT_MS,
      connectTimeoutMs: CONFIG.WHATSAPP.CONNECT_TIMEOUT_MS,
      keepAliveIntervalMs: CONFIG.WHATSAPP.KEEP_ALIVE_INTERVAL_MS,
      fireInitQueries: CONFIG.WHATSAPP.FIRE_INIT_QUERIES,
    });

    this.sock = sock;

    // Request pairing code if phone number is configured and not registered
    if (!state.creds.registered) {
      const phoneNumber = process.env.BOT_PHONE_NUMBER;
      if (phoneNumber) {
        setTimeout(async () => {
          try {
            const code = await sock.requestPairingCode(phoneNumber);
            console.log(`\n===================================`);
            console.log(`🔑 WHATSAPP PAIRING CODE: ${code}`);
            console.log(`===================================\n`);
            await logAudit('INFO', 'WHATSAPP_PAIRING_CODE', `WhatsApp Pairing Code generated: ${code}`);
          } catch (err: any) {
            console.error('Failed to request pairing code:', err);
          }
        }, 3000);
      }
    }

    // Listen for credentials updates to persist login
    sock.ev.on('creds.update', saveCreds);

    // Listen for connection states
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('\n--- SCAN THIS QR CODE TO LOG IN ---');
        qrcode.generate(qr, { small: true });
        console.log('-----------------------------------\n');
      }
      
      if (connection === 'close') {
        this.isReady = false;
        const isLoggedOut = (lastDisconnect?.error as Boom)?.output?.statusCode === DisconnectReason.loggedOut;
        const shouldReconnect = !isLoggedOut;
        
        await logAudit(
          'WARN',
          'WHATSAPP_CONNECTION_CLOSE',
          `WhatsApp connection closed. Reason: ${lastDisconnect?.error?.message || 'Unknown'}. Reconnecting: ${shouldReconnect}`
        );

        if (isLoggedOut) {
          await logAudit('INFO', 'WHATSAPP_SESSION_CLEAR', 'Clearing expired WhatsApp session credentials.');
          try {
            fs.rmSync(sessionDir, { recursive: true, force: true });
          } catch (err) {
            console.error('Failed to clear credentials directory:', err);
          }
          // Reconnect to print a fresh QR code
          this.connect();
        } else if (shouldReconnect) {
          this.connect();
        }
      } else if (connection === 'open') {
        this.isReady = true;
        await logAudit('INFO', 'WHATSAPP_CONNECTION_OPEN', 'WhatsApp Bot successfully connected to server.');
        for (const callback of this.connectionOpenCallbacks) {
          try {
            await callback();
          } catch (err: any) {
            console.error('Error running connection open callback:', err);
          }
        }
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
          const senderJid = msg.key.participant || msg.key.remoteJid || '';
          const chatJid = msg.key.remoteJid || '';
          
          const docMessage = this.getDocumentMessage(msg.message);
          const text = this.getMessageText(msg.message);

          const hasGoogleLink = typeof text === 'string' && /(?:docs|drive|sheets|forms|slides)\.google\.com/i.test(text);

          // Ignore self messages to avoid infinite loops, but allow them if they contain a document or Google Link
          if (msg.key.fromMe && !docMessage && !hasGoogleLink) {
            continue;
          }

          console.log(`📩 RECEIVED MESSAGE from ${senderJid} in chat ${chatJid}: "${text || (docMessage ? `[Document: ${docMessage.fileName}]` : '')}"`);

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
            senderPn: (msg.key as any).senderPn || undefined,
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
    if (!this.sock || !this.isReady) throw new Error('WhatsApp client not initialized or not connected');
    
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
    if (!this.sock || !this.isReady) throw new Error('WhatsApp client not initialized or not connected');

    try {
      await this.sock.sendMessage(jid, { text });
    } catch (err: any) {
      await logAudit('ERROR', 'WHATSAPP_SEND_MSG_FAILED', `Failed to send message to ${jid}: ${err.message}`);
      throw err;
    }
  }

  async addParticipants(groupJid: string, participants: string[]): Promise<void> {
    if (!this.sock || !this.isReady) throw new Error('WhatsApp client not initialized or not connected');
    try {
      await this.sock.groupParticipantsUpdate(groupJid, participants, 'add');
      await logAudit('INFO', 'WHATSAPP_PARTICIPANT_ADD', `Added users to ${groupJid}: ${participants.join(', ')}`);
    } catch (err: any) {
      await logAudit('ERROR', 'WHATSAPP_PARTICIPANT_ADD_FAILED', `Failed to add users to ${groupJid}: ${err.message}`);
      throw err;
    }
  }

  async removeParticipants(groupJid: string, participants: string[]): Promise<void> {
    if (!this.sock || !this.isReady) throw new Error('WhatsApp client not initialized or not connected');
    try {
      await this.sock.groupParticipantsUpdate(groupJid, participants, 'remove');
      await logAudit('INFO', 'WHATSAPP_PARTICIPANT_REMOVE', `Removed users from ${groupJid}: ${participants.join(', ')}`);
    } catch (err: any) {
      await logAudit('ERROR', 'WHATSAPP_PARTICIPANT_REMOVE_FAILED', `Failed to remove users from ${groupJid}: ${err.message}`);
      throw err;
    }
  }

  async promoteAdmins(groupJid: string, participants: string[]): Promise<void> {
    if (!this.sock || !this.isReady) throw new Error('WhatsApp client not initialized or not connected');
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
    if (!this.sock || !this.isReady) throw new Error('WhatsApp client not initialized or not connected');
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

  isConnected(): boolean {
    return this.isReady;
  }

  onConnectionOpen(callback: () => Promise<void> | void): void {
    this.connectionOpenCallbacks.push(callback);
    // If already connected, trigger immediately
    if (this.isReady) {
      try {
        callback();
      } catch (err: any) {
        console.error('Error running connection open callback:', err);
      }
    }
  }

  private getDocumentMessage(message: proto.IMessage | null | undefined): proto.IMessage['documentMessage'] | null | undefined {
    if (!message) return null;
    if (message.documentMessage) return message.documentMessage;
    if (message.documentWithCaptionMessage?.message?.documentMessage) return message.documentWithCaptionMessage.message.documentMessage;
    if (message.ephemeralMessage?.message) return this.getDocumentMessage(message.ephemeralMessage.message);
    if (message.viewOnceMessage?.message) return this.getDocumentMessage(message.viewOnceMessage.message);
    if (message.viewOnceMessageV2?.message) return this.getDocumentMessage(message.viewOnceMessageV2.message);
    return null;
  }

  private getMessageText(message: proto.IMessage | null | undefined): string {
    if (!message) return '';
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.documentMessage?.caption) return message.documentMessage.caption;
    if (message.documentWithCaptionMessage?.message?.documentMessage?.caption) {
      return message.documentWithCaptionMessage.message.documentMessage.caption;
    }
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    if (message.ephemeralMessage?.message) return this.getMessageText(message.ephemeralMessage.message);
    if (message.viewOnceMessage?.message) return this.getMessageText(message.viewOnceMessage.message);
    if (message.viewOnceMessageV2?.message) return this.getMessageText(message.viewOnceMessageV2.message);
    return '';
  }
}

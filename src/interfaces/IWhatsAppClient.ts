export interface DocumentAttachment {
  fileName: string;
  mimetype: string;
  mediaKey: Uint8Array;
  url: string;
  fileLength: number;
  directPath: string;
}

export interface IncomingMessage {
  senderJid: string; // The sender's WhatsApp ID (e.g. "60123456789@s.whatsapp.net")
  chatJid: string;   // The chat/group JID where it was sent
  text: string;      // The message content
  isGroup: boolean;  // True if sent in a group chat
  timestamp: number; // Unix timestamp
  document?: DocumentAttachment; // Optional document attachment
  senderPn?: string; // Optional real phone number JID if senderJid is an LID (e.g. "@s.whatsapp.net")
}

export interface IWhatsAppClient {
  /**
   * Initializes connection and scans QR code if necessary
   */
  connect(): Promise<void>;

  /**
   * Creates a new standard WhatsApp group with participants and returns the group JID
   */
  createGroup(subject: string, participants: string[]): Promise<string>;

  /**
   * Sends a text message to a JID (DM or Group)
   */
  sendMessage(jid: string, text: string): Promise<void>;

  /**
   * Adds participants to a group
   */
  addParticipants(groupJid: string, participants: string[]): Promise<void>;

  /**
   * Removes participants from a group
   */
  removeParticipants(groupJid: string, participants: string[]): Promise<void>;

  /**
   * Promotes participants to administrators in a group
   */
  promoteAdmins(groupJid: string, participants: string[]): Promise<void>;

  /**
   * Fetches the group invite code for a WhatsApp group JID
   */
  getGroupInviteCode(groupJid: string): Promise<string>;

  /**
   * Registers a listener callback for incoming WhatsApp messages
   */
  onMessage(callback: (message: IncomingMessage) => Promise<void> | void): void;

  /**
   * Fetches all groups the bot is participating in
   */
  getGroups(): Promise<{ id: string; subject: string }[]>;

  /**
   * Downloads a document file attachment from WhatsApp
   */
  downloadDocument(attachment: DocumentAttachment): Promise<Buffer>;

  /**
   * Registers a listener callback for group participant updates (e.g. users joining or leaving)
   */
  onGroupParticipantUpdate(callback: (event: { groupJid: string; participants: string[]; action: 'add' | 'remove' }) => Promise<void> | void): void;

  /**
   * Returns true if the WhatsApp client is fully connected and ready to make requests
   */
  isConnected(): boolean;

  /**
   * Registers a callback for when connection transitions to open state
   */
  onConnectionOpen(callback: () => Promise<void> | void): void;

  /**
   * Returns the bot's own WhatsApp JID (normalized) or null if not connected
   */
  getBotJid(): string | null;
}

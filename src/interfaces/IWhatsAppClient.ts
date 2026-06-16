export interface IncomingMessage {
  senderJid: string; // The sender's WhatsApp ID (e.g. "60123456789@s.whatsapp.net")
  chatJid: string;   // The chat/group JID where it was sent
  text: string;      // The message content
  isGroup: boolean;  // True if sent in a group chat
  timestamp: number; // Unix timestamp
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
   * Registers a listener callback for incoming WhatsApp messages
   */
  onMessage(callback: (message: IncomingMessage) => Promise<void> | void): void;
}

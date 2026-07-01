import { IncomingMessage } from '../../interfaces/IWhatsAppClient.js';

export interface CommandExecutionResult {
  replyText: string;
  shouldDeleteOriginal: boolean;
  isAnnounce?: boolean;
}

export interface ICommandRouter {
  executeCommand(
    msg: IncomingMessage,
    senderRole: 'teacher' | 'student',
    workshopId: string | null
  ): Promise<CommandExecutionResult | null>;
  compileProgressReport(workshopId: string): Promise<string>;
}

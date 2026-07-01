import { LLMEvaluationResult } from '../../interfaces/ILLMClient.js';

export interface ILLMBridge {
  evaluateEssay(
    questionPrompt: string,
    referenceAnswer: string,
    studentSubmission: string
  ): Promise<LLMEvaluationResult>;
}

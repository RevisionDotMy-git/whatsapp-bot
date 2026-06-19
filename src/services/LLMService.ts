import { GoogleGenerativeAI } from '@google/generative-ai';
import { ILLMClient, LLMEvaluationResult } from '../interfaces/ILLMClient.js';
import { CONFIG } from '../config/constants.js';
import { LLM_PROMPTS } from '../config/prompt.js';
import { logAudit } from './db.js';

export class LLMService implements ILLMClient {
  private ai: GoogleGenerativeAI;

  constructor() {
    this.ai = new GoogleGenerativeAI(CONFIG.GEMINI.API_KEY);
  }

  async evaluateEssay(
    questionPrompt: string,
    referenceAnswer: string,
    studentSubmission: string
  ): Promise<LLMEvaluationResult> {
    try {
      const model = this.ai.getGenerativeModel({
        model: CONFIG.GEMINI.MODEL_NAME,
        systemInstruction: LLM_PROMPTS.ESSAY_GRADER_SYSTEM_PROMPT,
      });

      const promptPayload = LLM_PROMPTS.getEvaluationPrompt(
        questionPrompt,
        referenceAnswer,
        studentSubmission
      );

      const response = await model.generateContent(promptPayload);
      const text = response.response.text();

      // Clean markdown code blocks from JSON if LLM outputs them
      const cleanJsonText = text
        .replace(/```json/g, '')
        .replace(/```/g, '')
        .trim();

      const evaluation = JSON.parse(cleanJsonText) as LLMEvaluationResult;
      
      await logAudit(
        'INFO',
        'LLM_EVALUATION',
        `Evaluated essay. Score given: ${evaluation.score}%.`
      );

      return evaluation;
    } catch (err: any) {
      await logAudit('ERROR', 'LLM_EVALUATION', `LLM Evaluation failed: ${err.message}`);
      throw err;
    }
  }
}

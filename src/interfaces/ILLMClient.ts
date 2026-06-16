export interface LLMEvaluationResult {
  score: number;
  feedback: string;
  weakness: string;
}

export interface ILLMClient {
  /**
   * Submits an essay question, standard reference answer, and the student's submission to the LLM for grading
   */
  evaluateEssay(
    questionPrompt: string,
    referenceAnswer: string,
    studentSubmission: string
  ): Promise<LLMEvaluationResult>;
}

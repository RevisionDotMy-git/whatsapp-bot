export interface IEnvDiagnostics {
  validateEnv(): Promise<boolean>;
  testDbConnection(): Promise<boolean>;
  testLearnDashConnection(): Promise<boolean>;
  testDirectories(): Promise<boolean>;
  runAllChecks(): Promise<boolean>;
}

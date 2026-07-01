# Environment & Diagnostics Module

This module is responsible for validating environment variables, testing database connectivity (PostgreSQL), checking WordPress LearnDash API authentication, and verifying local folder read/write permissions prior to launching the main Fastify server.

## Interface
`IEnvDiagnostics`

## Methods
- `validateEnv(): Promise<boolean>`: Validates env variables against a strict Zod schema.
- `testDbConnection(): Promise<boolean>`: Tests if the Prisma database client can perform queries. Suggests `systemctl` commands if PostgreSQL is down.
- `testLearnDashConnection(): Promise<boolean>`: Performs an authenticated fetch to the WordPress REST API.
- `testDirectories(): Promise<boolean>`: Assures `data/` and `whatsapp_session/` directories are writable.
- `runAllChecks(): Promise<boolean>`: Invokes all diagnostics sequentially. Returns `false` on critical failure to halt startup.

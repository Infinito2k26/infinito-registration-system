import { execSync } from 'child_process';
import { e2eDatabaseUrl } from './e2e-database';

/** Brings the disposable e2e database up to the current migrations before the suite runs. */
export default function globalSetup() {
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: e2eDatabaseUrl() },
    stdio: 'ignore',
  });
}

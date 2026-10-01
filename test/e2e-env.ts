import { e2eDatabaseUrl } from './e2e-database';

// Fully explicit configuration; .env is ignored when NODE_ENV=test (see AppModule).
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: e2eDatabaseUrl(),
  APP_BASE_URL: 'http://e2e.test',
  APP_SECRET: 'e2e-app-secret-e2e-app-secret-e2e-app-secret',
  FORMS_WEBHOOK_SECRET: 'e2e-webhook-secret',
  BOOTSTRAP_ADMIN_EMAILS: '',
  RESEND_API_KEY: '', // emails go to the console transport; nothing leaves the machine
  RESEND_WEBHOOK_SECRET: '',
  MAIL_FROM: '',
  EMAIL_TEST_RECIPIENT: '',
  EMAIL_WORKER_ENABLED: 'false', // tests drain the outbox explicitly with processBatch()
  EMAIL_SEND_INTERVAL_MS: '0',
  DECISION_EMAIL_DELAY_SECONDS: '0',
  QR_MANUAL_RESEND_LIMIT: '2',
  GOOGLE_SERVICE_ACCOUNT_JSON: '',
});

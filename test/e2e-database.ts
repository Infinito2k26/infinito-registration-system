/**
 * The e2e suite TRUNCATES every table, so it only runs against a database whose name
 * says it is disposable. Set E2E_DATABASE_URL, e.g.
 *   postgresql://postgres:infinito_dev_pwd@localhost:5433/infinito_e2e
 */
export function e2eDatabaseUrl(): string {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) throw new Error('Set E2E_DATABASE_URL to a disposable database (its name must contain "e2e" or "test")');
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!/e2e|test/i.test(name)) {
    throw new Error(`Refusing to run e2e tests against "${name}": the database name must contain "e2e" or "test"`);
  }
  return url;
}

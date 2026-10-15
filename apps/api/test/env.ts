process.env.NODE_ENV = 'test';
process.env.AUTH_THROTTLE_LIMIT = '10000';
process.env.THROTTLE_LIMIT = '100000';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
// Run the same suite against PostgreSQL: TEST_DATABASE_URL must point at a database whose name ends in _test.
if (process.env.TEST_DATABASE_URL) {
  process.env.STORE = 'prisma';
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.STORE = 'memory';
}

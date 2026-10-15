process.env.NODE_ENV = 'test';
process.env.AUTH_THROTTLE_LIMIT = '10000';
process.env.MAIL_THROTTLE_LIMIT = '10000';
process.env.MSG_THROTTLE_LIMIT = '10000';
process.env.THROTTLE_LIMIT = '100000';
process.env.REFRESH_REUSE_GRACE_SECONDS = '0';
process.env.CODE_RESEND_SECONDS = '0';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
// Run the same suite against PostgreSQL: TEST_DATABASE_URL must point at a database whose name ends in _test.
if (process.env.TEST_DATABASE_URL) {
  process.env.STORE = 'prisma';
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.STORE = 'memory';
}

// Uploaded photos go to a throwaway folder.
process.env.UPLOAD_DIR = require('path').join(require('os').tmpdir(), `freebie-radar-test-uploads-${process.pid}`);

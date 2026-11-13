import dotenv from 'dotenv';

export function loadServerEnvironment(options = {}) {
  // Local .env edits must take effect even when the launching shell has an old key.
  // Hosted production secrets retain precedence over any bundled .env file.
  return dotenv.config({ ...options, override: process.env.NODE_ENV !== 'production' });
}

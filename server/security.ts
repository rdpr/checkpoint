import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
export const secret = () => randomBytes(32).toString('base64url');
export const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [salt, encoded] = stored.split(':');
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(encoded, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function requireThat(
  condition: unknown,
  status: number,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new AppError(status, code, message);
}

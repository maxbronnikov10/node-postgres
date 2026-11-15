import nodeCrypto = require('crypto')
import type { webcrypto } from 'crypto'

/**
 * The Web Crypto API - grabbed from the Node.js library or the global
 * @type Crypto
 */
const webCrypto =
  nodeCrypto.webcrypto || (globalThis as typeof globalThis & { readonly crypto: webcrypto.Crypto }).crypto
/**
 * The SubtleCrypto API for low level crypto operations.
 * @type SubtleCrypto
 */
// Keep the legacy fourth argument passed to deriveBits; Web Crypto ignores it.
const subtleCrypto = webCrypto.subtle as webcrypto.SubtleCrypto & {
  deriveBits(
    algorithm: webcrypto.Pbkdf2Params,
    baseKey: webcrypto.CryptoKey,
    length: number,
    keyUsages: readonly webcrypto.KeyUsage[]
  ): Promise<ArrayBuffer>
}
const textEncoder = new TextEncoder()

/**
 *
 * @param {*} length
 * @returns
 */
export function randomBytes(length: number): Buffer {
  return webCrypto.getRandomValues(Buffer.alloc(length))
}

export async function md5(string: string | Buffer): Promise<string> {
  try {
    return nodeCrypto
      .createHash('md5')
      .update(string as string, 'utf-8')
      .digest('hex')
  } catch (e) {
    // `createHash()` failed so we are probably not in Node.js, use the WebCrypto API instead.
    // Note that the MD5 algorithm on WebCrypto is not available in Node.js.
    // This is why we cannot just use WebCrypto in all environments.
    const data = typeof string === 'string' ? textEncoder.encode(string) : string
    const hash = await subtleCrypto.digest('MD5', data)
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }
}

// See AuthenticationMD5Password at https://www.postgresql.org/docs/current/static/protocol-flow.html
export async function postgresMd5PasswordHash(user: string, password: string, salt: Buffer): Promise<string> {
  const inner = await md5(password + user)
  const outer = await md5(Buffer.concat([Buffer.from(inner), salt]))
  return 'md5' + outer
}

/**
 * Create a SHA-256 digest of the given data
 * @param {Buffer} data
 */
export async function sha256(text: webcrypto.BufferSource): Promise<ArrayBuffer> {
  return await subtleCrypto.digest('SHA-256', text)
}

export async function hashByName(hashName: string, text: webcrypto.BufferSource): Promise<ArrayBuffer> {
  return await subtleCrypto.digest(hashName, text)
}

/**
 * Sign the message with the given key
 * @param {ArrayBuffer} keyBuffer
 * @param {string} msg
 */
export async function hmacSha256(keyBuffer: webcrypto.BufferSource, msg: string): Promise<ArrayBuffer> {
  const key = await subtleCrypto.importKey('raw', keyBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return await subtleCrypto.sign('HMAC', key, textEncoder.encode(msg))
}

/**
 * Derive a key from the password and salt
 * @param {string} password
 * @param {Uint8Array} salt
 * @param {number} iterations
 */
export async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await subtleCrypto.importKey('raw', textEncoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const params = { name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: iterations }
  return await subtleCrypto.deriveBits(params, key, 32 * 8, ['deriveBits'])
}

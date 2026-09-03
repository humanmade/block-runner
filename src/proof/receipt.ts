import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** A complete SHA-256 content address, including its algorithm identifier. */
export type Sha256 = `sha256:${string}`;

/** The only values accepted by the canonical JSON encoder. */
export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

/**
 * The status vocabulary used by proof receipts. A receipt can carry more detail,
 * but a gate must always resolve to one of these values.
 */
export type ProofGateStatus = 'pass' | 'fail' | 'skip' | 'blocked' | 'not_applicable';

/** A deliberately open receipt shape: each proof runner owns its gate payloads. */
export interface ProofReceipt {
  [key: string]: unknown;
}

/** A portable reference to an immutable blob beneath the store root. */
export interface ContentAddressedReference {
  /** Content address for the exact stored bytes. */
  sha256: Sha256;
  /** Number of stored bytes. */
  bytes: number;
  /** POSIX-style path relative to the caller-supplied root. */
  path: string;
  /** Declared media type; it does not participate in the content address. */
  mediaType: string;
}

/** Reference returned after storing captured evidence. */
export interface EvidenceReference extends ContentAddressedReference {
  path: `evidence/sha256/${string}`;
}

/** Reference returned after writing a canonical receipt. */
export interface ReceiptReference extends ContentAddressedReference {
  path: `receipts/sha256/${string}.json`;
  mediaType: 'application/json';
}

export interface EvidencePutOptions {
  /** Defaults to text/plain for strings and application/octet-stream for bytes. */
  mediaType?: string;
}

export interface ReceiptWriteResult extends ReceiptReference {
  /** Exact UTF-8 JSON bytes whose digest is `sha256`. */
  canonicalJson: string;
  /** True only when this call created the address; false when it deduplicated. */
  created: boolean;
}

export type HashInput = string | Uint8Array | ArrayBuffer;

/**
 * Error raised if a path which ought to identify content has been modified, is a
 * non-file, or contains bytes different from those expected for its address.
 */
export class ImmutableContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImmutableContentError';
  }
}

/**
 * Produce deterministic JSON for receipt data.
 *
 * This intentionally accepts a smaller domain than JSON.stringify: undefined,
 * functions, symbols, bigint, non-finite numbers, sparse arrays, cycles, and
 * non-plain objects are errors rather than silently changed or omitted. That
 * makes a receipt's hash a faithful representation of the supplied data.
 */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set<object>(), '$');
}

/** Alias for callers that prefer the familiar JSON.stringify naming. */
export const canonicalJsonStringify = canonicalJson;

/** SHA-256 of UTF-8 text or exact byte input, in content-address form. */
export function sha256(input: HashInput): Sha256 {
  return `sha256:${createHash('sha256').update(asBuffer(input)).digest('hex')}`;
}

/** SHA-256 of the exact canonical JSON representation of a value. */
export function hashCanonicalJson(value: unknown): Sha256 {
  return sha256(canonicalJson(value));
}

/**
 * Stores arbitrary evidence below `<root>/evidence/sha256/<hex digest>`.
 * Existing content is never overwritten. A repeat write of identical bytes is
 * deduplicated; a mismatched pre-existing path is treated as tampering.
 */
export class EvidenceStore {
  readonly root: string;

  constructor(root: string) {
    if (!root || typeof root !== 'string') {
      throw new TypeError('EvidenceStore root must be a non-empty path');
    }
    this.root = path.resolve(root);
  }

  async put(input: HashInput, options: EvidencePutOptions = {}): Promise<EvidenceReference> {
    const bytes = asBuffer(input);
    const digest = sha256(bytes);
    const hex = addressHex(digest);
    const relativePath = `evidence/sha256/${hex}` as const;
    await writeImmutable(this.root, relativePath, bytes, digest);

    return {
      sha256: digest,
      bytes: bytes.byteLength,
      path: relativePath,
      mediaType: options.mediaType ?? defaultMediaType(input),
    };
  }

  /** Canonicalize an object first, then retain the exact JSON evidence bytes. */
  async putJson(value: unknown): Promise<EvidenceReference> {
    return this.put(canonicalJson(value), { mediaType: 'application/json' });
  }

  /** Read evidence and verify that its bytes still match its content address. */
  async read(reference: EvidenceReference | Sha256): Promise<Buffer> {
    const digest = typeof reference === 'string' ? reference : reference.sha256;
    const relativePath = `evidence/sha256/${addressHex(digest)}`;
    const bytes = await readVerified(path.join(this.root, ...relativePath.split('/')), digest);

    if (typeof reference !== 'string' && bytes.byteLength !== reference.bytes) {
      throw new ImmutableContentError(
        `evidence length changed for ${digest}: expected ${reference.bytes}, found ${bytes.byteLength}`,
      );
    }

    return bytes;
  }

  /** Stable, relative location for an address. It does not assert that it exists. */
  pathFor(address: Sha256): string {
    return `evidence/sha256/${addressHex(address)}`;
  }
}

/**
 * Writes canonical receipts below `<root>/receipts/sha256/<hex digest>.json`.
 * The receipt filename and returned `sha256` are both the hash of the exact
 * canonical JSON bytes, so the address can be checked without trusting the
 * surrounding run directory.
 */
export class ReceiptWriter {
  readonly root: string;
  readonly evidence: EvidenceStore;

  constructor(root: string) {
    if (!root || typeof root !== 'string') {
      throw new TypeError('ReceiptWriter root must be a non-empty path');
    }
    this.root = path.resolve(root);
    this.evidence = new EvidenceStore(this.root);
  }

  async write(receipt: object): Promise<ReceiptWriteResult> {
    if (!isPlainObject(receipt)) {
      throw new TypeError('A proof receipt must be a plain object');
    }

    const canonical = canonicalJson(receipt);
    const bytes = Buffer.from(canonical, 'utf8');
    const digest = sha256(bytes);
    const hex = addressHex(digest);
    const relativePath = `receipts/sha256/${hex}.json` as const;
    const stored = await writeImmutable(this.root, relativePath, bytes, digest);

    return {
      sha256: digest,
      bytes: bytes.byteLength,
      path: relativePath,
      mediaType: 'application/json',
      canonicalJson: canonical,
      created: stored.created,
    };
  }

  /** Read a receipt, verifying its address before parsing its canonical JSON. */
  async read(address: Sha256): Promise<ProofReceipt> {
    const relativePath = `receipts/sha256/${addressHex(address)}.json`;
    const bytes = await readVerified(path.join(this.root, ...relativePath.split('/')), address);
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isPlainObject(parsed)) {
      throw new ImmutableContentError(`receipt ${address} is not a JSON object`);
    }
    // A content hash alone protects bytes. Re-canonicalizing additionally makes
    // the stored receipt format itself part of the invariant.
    if (canonicalJson(parsed) !== bytes.toString('utf8')) {
      throw new ImmutableContentError(`receipt ${address} is not canonical JSON`);
    }
    return parsed;
  }

  pathFor(address: Sha256): string {
    return `receipts/sha256/${addressHex(address)}.json`;
  }
}

function canonicalize(value: unknown, ancestors: Set<object>, location: string): string {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return stringifyJsonPrimitive(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonical JSON cannot encode a non-finite number at ${location}`);
      }
      // JSON.stringify provides ECMAScript's shortest round-trippable form and
      // normalizes negative zero to the canonical JSON value 0.
      return stringifyJsonPrimitive(value);
    case 'undefined':
    case 'function':
    case 'symbol':
    case 'bigint':
      throw new TypeError(`canonical JSON cannot encode ${typeof value} at ${location}`);
    case 'object':
      break;
    default:
      throw new TypeError(`canonical JSON received an unsupported value at ${location}`);
  }

  if (ancestors.has(value)) {
    throw new TypeError(`canonical JSON cannot encode a cycle at ${location}`);
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new TypeError(`canonical JSON cannot encode a sparse array at ${location}[${index}]`);
        }
        items.push(canonicalize(value[index], ancestors, `${location}[${index}]`));
      }

      const nonIndexKeys = Object.keys(value).filter((key) => !isArrayIndex(key, value.length));
      if (nonIndexKeys.length > 0) {
        throw new TypeError(`canonical JSON cannot encode extra array properties at ${location}`);
      }
      assertNoEnumerableSymbols(value, location);
      return `[${items.join(',')}]`;
    }

    if (!isPlainObject(value)) {
      throw new TypeError(`canonical JSON can only encode plain objects at ${location}`);
    }
    assertNoEnumerableSymbols(value, location);

    const keys = Object.keys(value).sort();
    const properties = keys.map((key) => {
      const encodedKey = stringifyJsonPrimitive(key);
      return `${encodedKey}:${canonicalize(value[key], ancestors, `${location}.${encodedKey}`)}`;
    });
    return `{${properties.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stringifyJsonPrimitive(value: string | number): string {
  const encoded = JSON.stringify(value);
  // The type declaration permits undefined for arbitrary values, but it is
  // unreachable for the string and finite-number domain accepted above.
  if (encoded === undefined) {
    throw new TypeError('canonical JSON could not stringify a primitive');
  }
  return encoded;
}

function assertNoEnumerableSymbols(value: object, location: string): void {
  if (Object.getOwnPropertySymbols(value).some((symbol) => Object.prototype.propertyIsEnumerable.call(value, symbol))) {
    throw new TypeError(`canonical JSON cannot encode enumerable symbol keys at ${location}`);
  }
}

function isArrayIndex(key: string, length: number): boolean {
  // The string form must be exactly the canonical unsigned-index spelling.
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

function asBuffer(input: HashInput): Buffer {
  if (typeof input === 'string') {
    return Buffer.from(input, 'utf8');
  }
  if (input instanceof Uint8Array) {
    return Buffer.from(input);
  }
  if (input instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(input));
  }
  throw new TypeError('content must be a UTF-8 string, Uint8Array, or ArrayBuffer');
}

function defaultMediaType(input: HashInput): string {
  return typeof input === 'string' ? 'text/plain; charset=utf-8' : 'application/octet-stream';
}

function addressHex(address: Sha256): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(address)) {
    throw new TypeError(`invalid SHA-256 content address: ${address}`);
  }
  return address.slice('sha256:'.length);
}

async function writeImmutable(
  root: string,
  relativePath: string,
  bytes: Buffer,
  address: Sha256,
): Promise<{ created: boolean }> {
  const target = path.join(root, ...relativePath.split('/'));
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true });

  try {
    await assertStoredBytes(target, bytes, address);
    return { created: false };
  } catch (error: unknown) {
    if (!isErrno(error, 'ENOENT')) {
      throw error;
    }
  }

  // A hard-link publish is atomic and never replaces an existing address. The
  // temporary file is in the destination directory, so it is on the same fs.
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o444 });
    try {
      await link(temporary, target);
      return { created: true };
    } catch (error: unknown) {
      if (!isErrno(error, 'EEXIST')) {
        throw error;
      }
      await assertStoredBytes(target, bytes, address);
      return { created: false };
    }
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isErrno(error, 'ENOENT')) {
        throw error;
      }
    });
  }
}

async function assertStoredBytes(target: string, expected: Buffer, address: Sha256): Promise<void> {
  const existing = await readVerified(target, address);
  if (!existing.equals(expected)) {
    // This can only happen in the fantastically unlikely event of a SHA-256
    // collision, or when a store path was replaced between verification steps.
    throw new ImmutableContentError(`stored bytes differ for ${address} at ${target}`);
  }
}

async function readVerified(target: string, address: Sha256): Promise<Buffer> {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ImmutableContentError(`content address ${address} is not a regular file: ${target}`);
  }
  const bytes = await readFile(target);
  if (sha256(bytes) !== address) {
    throw new ImmutableContentError(`content address verification failed for ${address} at ${target}`);
  }
  return bytes;
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}


import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_VAULT_BYTES = 1024 * 1024;

/** The key stays outside the credential document. Both files are private to the hub OS user. */
export function readConnectorSecret(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o077) || (process.getuid && st.uid !== process.getuid()) || st.size > MAX_VAULT_BYTES)
      throw new Error('외부 연결 인증 파일의 권한이나 크기가 올바르지 않습니다');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

export class ConnectorVault<T> {
  private directory: string;
  constructor(directory: string) { this.directory = directory; }

  private key(create: boolean): Buffer {
    const path = join(this.directory, 'key');
    if (create && !existsSync(path)) writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 });
    const key = readConnectorSecret(path);
    if (key.length !== 32) throw new Error('외부 연결 암호화 키가 올바르지 않습니다');
    return key;
  }

  read(): T | undefined {
    const path = join(this.directory, 'credentials.enc');
    let bytes: Buffer;
    try { bytes = readConnectorSecret(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (bytes.length < 29 || bytes[0] !== 1) throw new Error('외부 연결 인증 파일이 손상되었습니다');
    const decipher = createDecipheriv('aes-256-gcm', this.key(false), bytes.subarray(1, 13));
    decipher.setAuthTag(bytes.subarray(13, 29));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString('utf8')) as T;
  }

  write(value: T) {
    const plain = Buffer.from(JSON.stringify(value));
    if (plain.length + 29 > MAX_VAULT_BYTES) throw new Error('외부 연결 인증정보가 저장 한도를 넘었습니다');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key(!existsSync(join(this.directory, 'credentials.enc'))), iv);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const temp = join(this.directory, randomBytes(12).toString('hex') + '.tmp');
    try {
      writeFileSync(temp, Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]), { flag: 'wx', mode: 0o600 });
      renameSync(temp, join(this.directory, 'credentials.enc'));
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
}

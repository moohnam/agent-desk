import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { HttpError } from './errors.ts';

export const DEFAULT_INSTRUCTIONS = readFileSync(new URL('../assets/default-instructions.md', import.meta.url), 'utf8').trimEnd();
export const MAX_INSTRUCTION_BYTES = 32 * 1024;
export function validateInstructions(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > MAX_INSTRUCTION_BYTES)
    throw new HttpError(400, '기본 지침은 32 KiB 이하의 텍스트여야 합니다');
}
const revision = (text: string) => createHash('sha256').update(text).digest('hex');

/** The gateway owns this file; runners receive an immutable copy with each new execution. */
export class InstructionStore {
  readonly path: string;
  constructor(path: string) { this.path = path; }
  read() {
    mkdirSync(dirname(this.path), { recursive: true });
    try { writeFileSync(this.path, DEFAULT_INSTRUCTIONS, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let text: string;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_INSTRUCTION_BYTES) throw new HttpError(400, '기본 지침 파일의 형식이나 크기를 확인하세요');
      text = readFileSync(fd, 'utf8');
      validateInstructions(text);
    } finally { closeSync(fd); }
    return { text, revision: revision(text), defaults: DEFAULT_INSTRUCTIONS };
  }
  save(text: unknown, expectedRevision: unknown) {
    validateInstructions(text);
    if (typeof expectedRevision !== 'string' || this.read().revision !== expectedRevision)
      throw new HttpError(409, '다른 곳에서 기본 지침이 변경되었습니다. 다시 열어 확인한 뒤 저장하세요');
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.path);
    } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    return this.read();
  }
}

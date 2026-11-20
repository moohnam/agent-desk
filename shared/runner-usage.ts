import type { EngineAuth, EngineUsage } from './api.ts';
import { ENGINES, type EngineName } from './compose.ts';

export interface UsageTarget { id: string; label: string; source?: string }
export interface UsageRequest { requestId: string; engine: EngineName; refresh: boolean }
export interface UsageReport { requestId: string; value: EngineUsage }
export interface UsageReading {
  status: 'ready' | 'offline' | 'unsupported' | 'error';
  value?: EngineUsage;
  message?: string;
  auth?: EngineAuth;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const short = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const stamp = (value: unknown) => short(value, 40) && Number.isFinite(Date.parse(value));
const requestId = (value: unknown) => short(value, 36) && /^[0-9a-f-]{36}$/.test(value);
const auth = (value: unknown) => value === undefined || value === 'authenticated' || value === 'signed-out' || value === 'unknown';
export const usageEngine = (value: unknown): value is EngineName => ENGINES.includes(value as EngineName);

export function checkUsageRequest(input: unknown): input is UsageRequest {
  return record(input) && requestId(input.requestId) && usageEngine(input.engine) && typeof input.refresh === 'boolean';
}

function checkUsageValue(input: unknown): input is EngineUsage {
  return record(input) && usageEngine(input.engine) && stamp(input.fetchedAt)
    && (input.plan === null || short(input.plan, 100)) && (input.error === undefined || short(input.error, 160)) && auth(input.auth)
    && Array.isArray(input.windows) && input.windows.length <= 40 && input.windows.every(window =>
      record(window) && short(window.label, 140) && (window.resetsAt === null || stamp(window.resetsAt))
      && (window.usedPercent === null || typeof window.usedPercent === 'number'
        && Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100));
}

export function checkUsageReport(input: unknown): input is UsageReport {
  return record(input) && requestId(input.requestId) && checkUsageValue(input.value);
}

export function checkUsageReading(input: unknown, engine: EngineName): input is UsageReading {
  return record(input) && ['ready', 'offline', 'unsupported', 'error'].includes(input.status as string)
    && (input.value === undefined ? input.status !== 'ready' : checkUsageValue(input.value) && input.value.engine === engine)
    && (input.message === undefined || short(input.message, 160)) && auth(input.auth);
}

export function checkUsageTargets(input: unknown): input is UsageTarget[] {
  return Array.isArray(input) && input.every(target => record(target) && short(target.id, 128) && !!target.id
    && short(target.label, 120) && (target.source === undefined || short(target.source, 128)));
}

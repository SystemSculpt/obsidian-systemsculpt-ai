import { resolveDefaultChatBackend } from '../DefaultChatBackend';
import { detectLocalAgents } from '../LocalAgentDetection';
import { hasHostCapability } from '../../../platform/hostCapabilities';
import { DEFAULT_SETTINGS } from '../../../types';
import { migrateSettingsToCurrentSchema } from '../../../core/settings/migrations/SettingsMigrator';
import { isLocalAgentId } from '../LocalAgents';

jest.mock('../LocalAgentDetection', () => ({ detectLocalAgents: jest.fn() }));
jest.mock('../../../platform/hostCapabilities', () => ({ hasHostCapability: jest.fn(() => true) }));
const settings = { ...DEFAULT_SETTINGS };
/** Narrows migrated persisted settings to the backend fields production validates before use. */
function migratedBackendSettings(raw: Record<string, unknown>): Parameters<typeof resolveDefaultChatBackend>[0] {
  const { textExecutionBackend, textExecutionBackendExplicit, licenseKey } = raw;
  if (!(isLocalAgentId(textExecutionBackend) || textExecutionBackend === 'systemsculpt')
    || typeof textExecutionBackendExplicit !== 'boolean' || typeof licenseKey !== 'string') {
    throw new Error('Expected migrated backend settings.');
  }
  return { textExecutionBackend, textExecutionBackendExplicit, licenseKey };
}
beforeEach(() => { jest.clearAllMocks(); jest.mocked(hasHostCapability).mockReturnValue(true); jest.mocked(detectLocalAgents).mockResolvedValue({ preferred: 'claude' } as never); });

it('detects for a fresh desktop chat without calling the hosted account service', async () => {
  const balance = jest.fn();
  expect(await resolveDefaultChatBackend(settings, balance)).toBe('claude');
  expect(balance).not.toHaveBeenCalled();
});
it.each(['claude', 'codex', 'systemsculpt'] as const)('honors explicit %s over detection', async backend => {
  expect(await resolveDefaultChatBackend({ ...settings, textExecutionBackend: backend, textExecutionBackendExplicit: true }, jest.fn())).toBe(backend);
  expect(detectLocalAgents).not.toHaveBeenCalled();
});
it.each(['claude', 'codex', 'systemsculpt'] as const)('mobile stays hosted for %s without probing local processes', async backend => {
  jest.mocked(hasHostCapability).mockReturnValue(false);
  expect(await resolveDefaultChatBackend({ ...settings, textExecutionBackend: backend }, jest.fn())).toBe('systemsculpt');
  expect(detectLocalAgents).not.toHaveBeenCalled();
});
it.each([{ licenseValid: true }, { subscriptionStatus: 'active' }, { subscriptionStatus: 'lifetime' }])('preserves a paid license after checking its entitlement %j', async paid => {
  const balance = jest.fn(async () => ({ includedCreditsEntitled: true }));
  expect(await resolveDefaultChatBackend({ ...settings, licenseKey: 'test', ...paid }, balance)).toBe('systemsculpt');
  expect(balance).toHaveBeenCalledTimes(1);
  expect(detectLocalAgents).not.toHaveBeenCalled();
});
it('detects for an upgraded starter account even when its license is valid and active', async () => {
  const migrated = migratedBackendSettings(migrateSettingsToCurrentSchema({
    schemaVersion: 14, textExecutionBackend: 'systemsculpt', licenseKey: 'starter',
    licenseValid: true, subscriptionStatus: 'active',
  }, DEFAULT_SETTINGS).settings);
  expect(await resolveDefaultChatBackend(migrated, async () => ({ includedCreditsEntitled: false }))).toBe('claude');
});
it('preserves an upgraded paid account through its live entitlement', async () => {
  const migrated = migratedBackendSettings(migrateSettingsToCurrentSchema({
    schemaVersion: 14, textExecutionBackend: 'systemsculpt', licenseKey: 'paid',
    licenseValid: true, subscriptionStatus: 'active',
  }, DEFAULT_SETTINGS).settings);
  expect(await resolveDefaultChatBackend(migrated, async () => ({ includedCreditsEntitled: true }))).toBe('systemsculpt');
  expect(detectLocalAgents).not.toHaveBeenCalled();
});
it('preserves hosted when an older balance response cannot establish entitlement', async () => {
  expect(await resolveDefaultChatBackend({ ...settings, licenseKey: 'test' }, async () => ({}))).toBe('systemsculpt');
});
it('preserves hosted when the live balance says included credits are entitled', async () => {
  expect(await resolveDefaultChatBackend({ ...settings, licenseKey: 'test' }, async () => ({ includedCreditsEntitled: true }))).toBe('systemsculpt');
  expect(detectLocalAgents).not.toHaveBeenCalled();
});
it('detects when the live balance confirms no included-credits entitlement', async () => {
  expect(await resolveDefaultChatBackend({ ...settings, licenseKey: 'test' }, async () => ({ includedCreditsEntitled: false }))).toBe('claude');
});
it('does not silently switch a possibly paid account when its entitlement read fails', async () => {
  expect(await resolveDefaultChatBackend({ ...settings, licenseKey: 'test' }, async () => { throw new Error('offline'); })).toBe('systemsculpt');
});
it.each([
  [{ textExecutionBackend: 'systemsculpt' }, false],
  [{ textExecutionBackend: 'systemsculpt', licenseKey: 'paid', licenseValid: true }, false],
  [{ textExecutionBackend: 'systemsculpt', licenseKey: 'paid', subscriptionStatus: 'active' }, false],
  [{ textExecutionBackend: 'systemsculpt', licenseKey: 'paid', subscriptionStatus: 'lifetime' }, false],
  [{ textExecutionBackend: 'claude' }, true],
  [{ textExecutionBackend: 'codex' }, true],
])('migrates legacy backend intent %j', (raw, explicit) => {
  const migrated = migrateSettingsToCurrentSchema({ ...raw, schemaVersion: 14 }, DEFAULT_SETTINGS).settings;
  expect(migrated.textExecutionBackendExplicit).toBe(explicit);
});
it.each(['default', 'acceptEdits', 'plan', 'settings'])('migrates Claude %s once without changing deliberate modes', mode => {
  const first = migrateSettingsToCurrentSchema({ schemaVersion: 14, claudePermissionMode: mode }, DEFAULT_SETTINGS).settings;
  expect(first.claudePermissionMode).toBe(mode === 'default' ? 'auto' : mode);
  const chosen = { ...first, claudePermissionMode: 'manual', textExecutionBackend: 'systemsculpt', textExecutionBackendExplicit: true };
  expect(migrateSettingsToCurrentSchema(chosen, DEFAULT_SETTINGS).settings).toMatchObject(chosen);
});

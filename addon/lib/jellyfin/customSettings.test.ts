// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
//
// This fork's settings in the dashboard: marked Custom, in the registry once each, without the
// logins, and with the defaults the settings' readers really use.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOM_SETTINGS } from './customSettings';
import { SETTINGS_REGISTRY, getSettingDefinition } from '../settingsRegistry';
import { dispatcharrSettings } from './dispatcharr/settings';
import { recordingSettings } from './recordings/settings';

const LOGINS = [
  'JELLYFIN_DISPATCHARR_API_KEY',
  'JELLYFIN_DISPATCHARR_USERNAME',
  'JELLYFIN_DISPATCHARR_PASSWORD',
  'JELLYFIN_DISPATCHARR_XC_USERNAME',
  'JELLYFIN_DISPATCHARR_XC_PASSWORD',
];

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

/** Sets a variable by name (a login's included, which the registry check would take for code reading it). */
function setEnv(name: string, value: string): void {
  process.env[name] = value;
}

/** No custom setting set, as on a server that has never saved one. */
function clearCustom(): void {
  for (const def of CUSTOM_SETTINGS) delete process.env[def.envVar];
  for (const name of LOGINS) delete process.env[name];
}

test('every custom setting is marked Custom, in a Custom section', () => {
  assert.ok(CUSTOM_SETTINGS.length > 0);
  for (const def of CUSTOM_SETTINGS) {
    assert.ok(def.label.startsWith('Custom · '), `${def.key}'s label isn't marked Custom`);
    assert.ok(def.category.startsWith('Custom: '), `${def.key} isn't in a Custom section`);
    assert.equal(def.key, def.envVar);
  }
});

test('the logins stay out of the dashboard', () => {
  for (const name of LOGINS) {
    assert.equal(getSettingDefinition(name), undefined, `${name} is in the dashboard`);
  }
  // The one secret kept in the dashboard, as its owner asked: masked there and left out of exports.
  for (const def of CUSTOM_SETTINGS) assert.equal(def.sensitive === true, def.key === 'JELLYFIN_SPORTS_BOXERBOOK_KEY', `${def.key} is or isn't secret`);
});

test('each custom setting is in the registry once', () => {
  for (const def of CUSTOM_SETTINGS) {
    assert.equal(SETTINGS_REGISTRY.filter((entry) => entry.key === def.key).length, 1, `${def.key} isn't listed once`);
    assert.equal(getSettingDefinition(def.key), def);
  }
});

test("a select's default is one of its choices", () => {
  for (const def of CUSTOM_SETTINGS.filter((entry) => entry.type === 'select')) {
    assert.ok(def.options?.includes(String(def.default)), `${def.key}'s default isn't a choice`);
  }
});

test("Dispatcharr's defaults are the ones the dashboard shows", () => {
  clearCustom();
  setEnv('JELLYFIN_DISPATCHARR_URL', 'http://dispatcharr.test:9191');
  setEnv('JELLYFIN_DISPATCHARR_API_KEY', 'test-key');
  const settings = dispatcharrSettings();
  assert.ok(settings);
  const shown = (key: string) => getSettingDefinition(key)?.default;
  assert.equal(settings.name, shown('JELLYFIN_DISPATCHARR_NAME'));
  assert.equal(settings.autoSource, shown('JELLYFIN_DISPATCHARR_AUTO_SOURCE'));
  assert.equal(settings.switchStreams, shown('JELLYFIN_DISPATCHARR_SWITCH_STREAMS'));
  assert.equal(settings.timeoutMs, Number(shown('JELLYFIN_DISPATCHARR_TIMEOUT')) * 1000);
  assert.equal(settings.cacheMs, Number(shown('JELLYFIN_DISPATCHARR_CACHE_SECONDS')) * 1000);
  assert.equal(settings.outputFormat, undefined);
  assert.equal(settings.streamUrl, settings.url);
  assert.deepEqual(settings.users, []);
  assert.deepEqual(settings.groups, []);
});

test("the stream format's default choice is Dispatcharr's own format", () => {
  clearCustom();
  setEnv('JELLYFIN_DISPATCHARR_URL', 'http://dispatcharr.test:9191');
  setEnv('JELLYFIN_DISPATCHARR_API_KEY', 'test-key');
  setEnv('JELLYFIN_DISPATCHARR_OUTPUT_FORMAT', 'default');
  assert.equal(dispatcharrSettings()?.outputFormat, undefined);
  setEnv('JELLYFIN_DISPATCHARR_OUTPUT_FORMAT', 'hls');
  assert.equal(dispatcharrSettings()?.outputFormat, 'hls');
});

test("recording's defaults are the ones the dashboard shows", () => {
  clearCustom();
  const shown = (key: string) => Number(getSettingDefinition(key)?.default);
  const settings = recordingSettings(true);
  assert.equal(settings.preMinutes, shown('JELLYFIN_RECORDINGS_PRE_MINUTES'));
  assert.equal(settings.postMinutes, shown('JELLYFIN_RECORDINGS_POST_MINUTES'));
  assert.equal(settings.keepDays, shown('JELLYFIN_RECORDINGS_KEEP_DAYS'));
  assert.equal(settings.maxAtOnce, shown('JELLYFIN_RECORDINGS_MAX_AT_ONCE'));
  assert.ok(settings.dir.endsWith(String(getSettingDefinition('JELLYFIN_RECORDINGS_DIR')?.default)));
  assert.deepEqual(settings.users, []);
});

test('auto records with Dispatcharr where Live TV comes from it, and is off otherwise', () => {
  clearCustom();
  setEnv('JELLYFIN_RECORDINGS', 'auto');
  assert.equal(recordingSettings(true).mode, 'dispatcharr');
  assert.equal(recordingSettings(false).mode, 'off');
  setEnv('JELLYFIN_RECORDINGS', 'local');
  assert.equal(recordingSettings(true).mode, 'local');
});

test('a value saved in the dashboard is read straight away', () => {
  clearCustom();
  // The dashboard puts a saved value into the environment, which the readers look at on each use.
  setEnv('JELLYFIN_RECORDINGS', 'off');
  assert.equal(recordingSettings(true).mode, 'off');
  setEnv('JELLYFIN_RECORDINGS', 'dispatcharr');
  assert.equal(recordingSettings(true).mode, 'dispatcharr');
});

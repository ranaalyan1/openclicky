import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DEFAULT_SETTINGS, loadSettings, maskApiKey, publicSettings, saveSettings, settingsPath } from '../src/settings.js';

function tempFile(): { file: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclicky-settings-'));
  return { dir, file: path.join(dir, 'config.json') };
}

test('settingsPath honors OPENCLICKY_CONFIG override', () => {
  assert.equal(settingsPath({ OPENCLICKY_CONFIG: '/tmp/custom.json' } as any), '/tmp/custom.json');
});

test('loadSettings: defaults → file → env precedence', () => {
  const { dir, file } = tempFile();
  try {
    // plain defaults
    assert.deepEqual(loadSettings({} as any, file), DEFAULT_SETTINGS);

    // file overrides defaults
    saveSettings({ baseUrl: 'http://localhost:1234/v1', model: 'llama-3.2', apiKey: 'local-key' }, file);
    const fromFile = loadSettings({} as any, file);
    assert.equal(fromFile.baseUrl, 'http://localhost:1234/v1');
    assert.equal(fromFile.model, 'llama-3.2');
    assert.equal(fromFile.apiKey, 'local-key');

    // env overrides file
    const fromEnv = loadSettings({ OPENCLICKY_MODEL: 'env-model', OPENCLICKY_MODEL_KEY: 'env-key' } as any, file);
    assert.equal(fromEnv.model, 'env-model');
    assert.equal(fromEnv.apiKey, 'env-key');
    assert.equal(fromEnv.baseUrl, 'http://localhost:1234/v1', 'fields not in env still come from the file');

    // vision: env beats file; OPENCLICKY_VISION=0 means false
    assert.equal(loadSettings({ OPENCLICKY_VISION: '0' } as any, file).vision, false);
    assert.equal(loadSettings({} as any, file).vision, true, 'default vision');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveSettings merges (only provided fields change) and writes mode-600', () => {
  const { dir, file } = tempFile();
  try {
    saveSettings({ model: 'first', apiKey: 'k1' }, file);
    const merged = saveSettings({ model: 'second' }, file);
    assert.equal(merged.model, 'second');
    assert.equal(merged.apiKey, 'k1', 'untouched fields survive a partial save');

    const stat = fs.statSync(file);
    assert.equal(stat.mode & 0o777, 0o600, 'config file is owner-read/write only');

    const tidy = saveSettings(
      { baseUrl: 'https://api.example.com/v1///', model: '  gpt-4o  ', apiKey: '  sk-x  ' },
      file,
    );
    assert.equal(tidy.baseUrl, 'https://api.example.com/v1', 'trailing slashes stripped');
    assert.equal(tidy.model, 'gpt-4o', 'model trimmed');
    assert.equal(tidy.apiKey, 'sk-x', 'key trimmed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('KEY 2 · search: file + env precedence, provider guard, and masking', () => {
  const { dir, file } = tempFile();
  try {
    saveSettings({ searchApiKey: '  BSA-first  ', searchProvider: 'brave' }, file);
    const fromFile = loadSettings({} as any, file);
    assert.equal(fromFile.searchApiKey, 'BSA-first', 'trimmed on save');
    assert.equal(fromFile.searchProvider, 'brave');

    // env wins for key #2 exactly like key #1
    const fromEnv = loadSettings({ OPENCLICKY_SEARCH_KEY: 'BSA-env' } as any, file);
    assert.equal(fromEnv.searchApiKey, 'BSA-env');
    assert.equal(fromEnv.searchProvider, 'brave', 'provider not in env still comes from the file');

    // an unknown provider in the file falls back to the default instead of poisoning it
    fs.writeFileSync(file, JSON.stringify({ searchApiKey: 'k', searchProvider: 'bing' }));
    assert.equal(loadSettings({} as any, file).searchProvider, 'auto');

    // an empty string is meaningful: it clears key #2 (back to DuckDuckGo)
    const cleared = saveSettings({ searchApiKey: '', searchProvider: 'duckduckgo' }, file);
    assert.equal(cleared.searchApiKey, '');
    assert.equal(cleared.searchProvider, 'duckduckgo');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('defaults ship with no search key and the auto provider', () => {
  assert.equal(DEFAULT_SETTINGS.searchApiKey, '');
  assert.equal(DEFAULT_SETTINGS.searchProvider, 'auto');
  const pub = publicSettings(DEFAULT_SETTINGS);
  assert.equal(pub.hasSearchKey, false);
});

test('keys never leak: maskApiKey + publicSettings', () => {
  assert.equal(maskApiKey(''), '');
  assert.equal(maskApiKey('sk-abcdef123456'), 'sk-••••456');
  assert.equal(maskApiKey('abc'), '••••••');

  const pub = publicSettings({ ...DEFAULT_SETTINGS, apiKey: 'sk-supersecret' });
  assert.equal(pub.hasKey, true);
  assert.ok(!JSON.stringify(pub).includes('sk-supersecret'), 'public view never contains the raw key');

  const both = publicSettings({ ...DEFAULT_SETTINGS, apiKey: 'sk-secret-1', searchApiKey: 'BSA-secret-2' });
  assert.equal(both.hasSearchKey, true);
  const wire = JSON.stringify(both);
  assert.ok(!wire.includes('sk-secret-1'));
  assert.ok(!wire.includes('BSA-secret-2'), 'the search key is masked too');
  assert.equal(both.searchKeyPreview, 'BSA••••t-2');
});

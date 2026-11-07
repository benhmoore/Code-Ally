/** Focused settings help and compact overviews from the shared configuration metadata. */
import type { Config } from '../types/index.js';
import { DEFAULT_CONFIG } from './defaults.js';
import {
  CONFIG_CATEGORIES,
  CONFIG_CHOICES,
  CONFIG_DESCRIPTIONS,
  CONFIG_NUMBER_RULES,
  CONFIG_SUGGESTIONS,
  formatConfigValue,
} from './metadata.js';

const overviewCategories: Record<string, (keyof Config)[]> = {
  Connection: ['provider', 'endpoint', 'model', 'service_model'],
  Generation: ['context_size', 'max_tokens', 'reasoning_effort', 'temperature'],
  Interaction: ['permission_mode', 'parallel_tools', 'show_thinking_in_chat', 'mouse_support'],
  Search: ['search_provider'],
};

function settingValue(config: Readonly<Config>, key: keyof Config): string {
  if (key === 'model' && !config.model) return '(not selected)';
  if (key === 'service_model' && !config.service_model)
    return `follows main model${config.model ? ` (${config.model})` : ''}`;
  return formatConfigValue(key, config[key]);
}

export function configurationCategories(): Record<string, (keyof Config)[]> {
  const declared = new Set(Object.values(CONFIG_CATEGORIES).flat());
  const other = (Object.keys(DEFAULT_CONFIG) as (keyof Config)[]).filter(key => !declared.has(key));
  return { ...CONFIG_CATEGORIES, ...(other.length ? { Other: other } : {}) };
}

/** Return an actionable setting description without exposing secret values. */
export function describeConfigSetting(config: Readonly<Config>, key: keyof Config): string {
  const value = settingValue(config, key);
  const lines = [
    `**${key}**`,
    CONFIG_DESCRIPTIONS[key] ?? 'Application setting.',
    '',
    `Current: ${value}`,
    `Default: ${formatConfigValue(key, DEFAULT_CONFIG[key])}`,
  ];
  const choices = CONFIG_CHOICES[key] ?? CONFIG_SUGGESTIONS[key];
  if (choices) lines.push(`Suggested values: ${choices.map(value => formatConfigValue(key, value)).join(', ')}`);
  const rule = CONFIG_NUMBER_RULES[key];
  if (rule) {
    const bounds = [
      rule.integer ? 'whole number' : 'number',
      rule.minimum === undefined ? undefined : `at least ${rule.minimum}`,
      rule.maximum === undefined ? undefined : `at most ${rule.maximum}`,
    ].filter(Boolean);
    lines.push(`Accepted: ${bounds.join(', ')}`);
  }
  const example = choices?.find(value => value !== null) ?? DEFAULT_CONFIG[key];
  const exampleValue = example === undefined ? 'null' : JSON.stringify(example);
  lines.push('', `Change: /config set ${key}=${exampleValue}`, `Reset: /config reset ${key}`);
  if (key === 'model' || key === 'service_model')
    lines.push(`Pick a model: /model${key === 'service_model' ? ' service' : ''}`);
  if (['provider', 'endpoint', 'api_key'].includes(key)) lines.push('Guided connection setup: /config setup');
  return lines.join('\n');
}

/** Render common settings first; full, category, changed and single-key views remain available. */
export function presentConfiguration(config: Readonly<Config>, query?: string): string | null {
  if (query && Object.hasOwn(DEFAULT_CONFIG, query)) return describeConfigSetting(config, query as keyof Config);
  const normalized = query?.toLowerCase();
  const all = configurationCategories();
  let categories: Record<string, (keyof Config)[]>;
  if (!query) categories = overviewCategories;
  else if (normalized === 'all' || normalized === 'changed') categories = all;
  else
    categories = Object.fromEntries(Object.entries(all).filter(([name]) => name.toLowerCase().includes(normalized!)));
  if (!Object.keys(categories).length) return null;
  const lines = ['# Configuration', 'Saved settings apply to this session unless a setting says otherwise.', ''];
  let count = 0;
  for (const [category, keys] of Object.entries(categories)) {
    const visible = keys.filter(
      key => normalized !== 'changed' || JSON.stringify(config[key]) !== JSON.stringify(DEFAULT_CONFIG[key])
    );
    if (!visible.length) continue;
    lines.push(`**${category}**`);
    for (const key of visible) {
      const value = settingValue(config, key);
      lines.push(`- ${key}: ${value}`);
      count++;
    }
    lines.push('');
  }
  if (!count) lines.push('All settings use their defaults.', '');
  lines.push(
    'Change a value: /config set context_size=32768',
    'Inspect a setting: /config show context_size',
    'All settings: /config show all · Changes: /config show changed',
    'Choose a model: /model · Background model: /model service',
    'Connection setup: /config setup · Reset app settings: /config reset [key]'
  );
  return lines.join('\n');
}

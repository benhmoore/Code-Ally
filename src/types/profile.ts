/**
 * Profile metadata and configuration
 */
export interface Profile {
  name: string;
  description?: string;
  created_at: string; // ISO 8601 timestamp
  updated_at: string; // ISO 8601 timestamp
  tags?: string[];
  default_model?: string;
  metadata?: Record<string, any>;
}

export interface ProfileInfo {
  name: string;
  description?: string;
  created_at: string;
  plugin_count: number;
  agent_count: number;
  prompt_count: number;
}

export interface CreateProfileOptions {
  description?: string;
  tags?: string[];
  cloneFrom?: string; // Clone from existing profile
}

export interface ProfileStats {
  plugin_count: number;
  agent_count: number;
  prompt_count: number;
  config_overrides: number;
  storage_size_bytes?: number;
}

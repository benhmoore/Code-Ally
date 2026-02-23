/**
 * Tests for toKebabCase utility
 */

import { describe, it, expect } from 'vitest';
import { toKebabCase } from '@utils/namingValidation.js';

describe('toKebabCase', () => {
  it('converts camelCase to kebab-case', () => {
    expect(toKebabCase('readFile')).toBe('read-file');
    expect(toKebabCase('getListOfFiles')).toBe('get-list-of-files');
  });

  it('converts PascalCase to kebab-case', () => {
    expect(toKebabCase('ReadFile')).toBe('read-file');
    expect(toKebabCase('GetListOfFiles')).toBe('get-list-of-files');
  });

  it('converts snake_case to kebab-case', () => {
    expect(toKebabCase('read_file')).toBe('read-file');
    expect(toKebabCase('get_list_of_files')).toBe('get-list-of-files');
  });

  it('converts spaces to hyphens', () => {
    expect(toKebabCase('read file')).toBe('read-file');
    expect(toKebabCase('get list of files')).toBe('get-list-of-files');
  });

  it('handles already kebab-case', () => {
    expect(toKebabCase('read-file')).toBe('read-file');
    expect(toKebabCase('get-list-of-files')).toBe('get-list-of-files');
  });

  it('collapses multiple separators', () => {
    expect(toKebabCase('read__file')).toBe('read-file');
    expect(toKebabCase('read--file')).toBe('read-file');
    expect(toKebabCase('read  file')).toBe('read-file');
  });

  it('removes non-alphanumeric characters', () => {
    expect(toKebabCase('read@file')).toBe('readfile');
    expect(toKebabCase('read.file')).toBe('read-file');
  });

  it('strips leading/trailing hyphens', () => {
    expect(toKebabCase('-read-file-')).toBe('read-file');
    expect(toKebabCase('_read_file_')).toBe('read-file');
  });

  it('lowercases everything', () => {
    expect(toKebabCase('READ_FILE')).toBe('read-file');
    expect(toKebabCase('ReadFILE')).toBe('read-file');
  });

  it('handles mixed formats', () => {
    expect(toKebabCase('myTool_name v2')).toBe('my-tool-name-v2');
  });
});

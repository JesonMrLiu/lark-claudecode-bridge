import { describe, it, expect } from 'vitest';
import { VERSION } from '../src/index.js';

describe('smoke', () => {
  it('环境可用', () => {
    expect(VERSION).toBe('0.1.0');
  });
});

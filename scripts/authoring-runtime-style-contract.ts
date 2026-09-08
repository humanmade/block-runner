#!/usr/bin/env node
/**
 * Invoke the production selector scoper from the runtime worker without
 * duplicating its selector grammar in the worker's CommonJS process.
 */
import { readFileSync } from 'node:fs';
import { scopeLocalSelectorList } from '../src/author/styles.js';

type InputStyle = {
  index: number;
  transportSelector?: string;
  source?: { selector?: string };
};

type Input = {
  root: string;
  foundation?: 'component';
  styles: InputStyle[];
};

const inputFile = process.argv[2];
if (!inputFile) throw new Error('style-contract input file is required');
const input = JSON.parse(readFileSync(inputFile, 'utf8')) as Input;
if (typeof input.root !== 'string' || !Array.isArray(input.styles)
  || (input.foundation !== undefined && input.foundation !== 'component')) {
  throw new Error('style-contract input is invalid');
}

const entries = input.styles.map((style) => {
  const selector = style.transportSelector ?? style.source?.selector;
  if (!Number.isInteger(style.index) || typeof selector !== 'string') {
    throw new Error(`coverage style ${style.index} has no transport or source selector`);
  }
  const scoped = scopeLocalSelectorList(selector, input.root, { foundation: input.foundation });
  if (!scoped.ok) throw new Error(`coverage style ${style.index} cannot be scoped: ${scoped.reason}`);
  return { index: style.index, sourceSelector: selector, renderedSelector: scoped.selector };
});

process.stdout.write(`${JSON.stringify({ entries })}\n`);

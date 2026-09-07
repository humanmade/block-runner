import { describe, expect, it } from 'vitest';
import { validateSourceContent } from '../src/author/content.js';

const paragraph = (content: string): unknown[] => ['core/paragraph', { content }, []];
const image = (alt: string): unknown[] => ['core/image', { url: './assets/example.svg', alt }, []];
const button = (text: string, url: string): unknown[] => ['core/buttons', {}, [['core/button', { text, url }, []]]];

describe('source-bound content fulfillment', () => {
  it('rejects an all-blank compiled content skeleton', () => {
    expect(() => validateSourceContent('<h2>Keep the source words</h2>', [['core/heading', { level: 2, content: '' }, []]]))
      .toThrow(/visible text sequence changed/);
  });

  it('rejects omitted or reordered authored text', () => {
    expect(() => validateSourceContent('<p>First sentence.</p><p>Second sentence.</p>', [paragraph('Second sentence.')]))
      .toThrow(/visible text sequence changed/);
    expect(() => validateSourceContent('<p>First sentence.</p><p>Second sentence.</p>', [paragraph('Second sentence.'), paragraph('First sentence.')]))
      .toThrow(/visible text sequence changed/);
  });

  it('accepts equivalent rich inline text despite native wrapper whitespace', () => {
    expect(() => validateSourceContent('<section><p>Keep <strong>inline punctuation!</strong></p><div>Then continue.</div></section>', [
      paragraph('Keep <strong>inline punctuation!</strong>'),
      paragraph('Then continue.'),
    ])).not.toThrow();
  });

  it('rejects a changed link href while retaining its label check', () => {
    expect(() => validateSourceContent('<a href="/source-guide">Read the guide</a>', [button('Read the guide', '/changed-guide')]))
      .toThrow(/links changed/);
  });

  it('rejects lost image alternative text', () => {
    expect(() => validateSourceContent('<img src="./source.svg" alt="Release checklist">', [image('')]))
      .toThrow(/image alt text changed/);
  });

  it('accepts an ordinary native structure with text, link, and image alt text', () => {
    expect(() => validateSourceContent('<section><h2>Release evidence</h2><p>Keep every handoff explainable.</p><a href="/guide">Read the guide</a><img src="./source.svg" alt="Release checklist"></section>', [
      ['core/group', {}, [['core/heading', { level: 2, content: 'Release evidence' }, []], paragraph('Keep every handoff explainable.'), button('Read the guide', '/guide'), image('Release checklist')]],
    ])).not.toThrow();
  });
});

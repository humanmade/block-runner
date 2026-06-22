import { createRequire } from 'node:module';
import { JSDOM, VirtualConsole } from 'jsdom';
import { HeadlessBootError, WpModules } from '../types.js';

let bootPromise: Promise<WpModules> | undefined;

export async function bootHeadlessWordPress(): Promise<WpModules> {
  if (!bootPromise) {
    bootPromise = boot();
  }

  return bootPromise;
}

async function boot(): Promise<WpModules> {
  try {
    installDomGlobals();

    const require = createRequire(import.meta.url);
    const { blockLibrary, blocks } = withMutedWordPressConsole(() => ({
      blockLibrary: require('@wordpress/block-library') as {
        registerCoreBlocks: () => void;
      },
      blocks: require('@wordpress/blocks') as WpModules,
    }));

    withMutedWordPressConsole(() => {
      blockLibrary.registerCoreBlocks();
    });

    return {
      createBlock: blocks.createBlock,
      parse: blocks.parse,
      serialize: blocks.serialize,
      validateBlock: blocks.validateBlock,
      getBlockType: blocks.getBlockType,
    };
  } catch (error) {
    bootPromise = undefined;
    throw new HeadlessBootError('Failed to boot headless Gutenberg.', { cause: error });
  }
}

function installDomGlobals(): void {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {
    // Newer Gutenberg UI packages inject CSS syntax jsdom 24 cannot parse.
    // Those styles are irrelevant for block parse/serialize/validate behavior.
  });

  const dom = new JSDOM('<!DOCTYPE html>', {
    pretendToBeVisual: true,
    virtualConsole,
  });

  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLAnchorElement: dom.window.HTMLAnchorElement,
    HTMLImageElement: dom.window.HTMLImageElement,
    DOMParser: dom.window.DOMParser,
    MutationObserver: dom.window.MutationObserver,
    Event: dom.window.Event,
    EventTarget: dom.window.EventTarget,
    CustomEvent: dom.window.CustomEvent,
    File: dom.window.File,
    Blob: dom.window.Blob,
    self: dom.window,
  };

  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  globalThis.window.matchMedia =
    globalThis.window.matchMedia ??
    (() => ({
      matches: false,
      media: '',
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    }));
}

export function withMutedWordPressConsole<T>(fn: () => T): T {
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalGroupCollapsed = console.groupCollapsed;
  const originalGroupEnd = console.groupEnd;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const windowConsole = globalThis.window?.console;
  const originalWindow = windowConsole
    ? {
        warn: windowConsole.warn,
        error: windowConsole.error,
        log: windowConsole.log,
        info: windowConsole.info,
        groupCollapsed: windowConsole.groupCollapsed,
        groupEnd: windowConsole.groupEnd,
      }
    : undefined;

  console.warn = () => {};
  console.error = () => {};
  console.log = () => {};
  console.info = () => {};
  console.groupCollapsed = () => {};
  console.groupEnd = () => {};
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  if (windowConsole) {
    windowConsole.warn = () => {};
    windowConsole.error = () => {};
    windowConsole.log = () => {};
    windowConsole.info = () => {};
    windowConsole.groupCollapsed = () => {};
    windowConsole.groupEnd = () => {};
  }

  try {
    return fn();
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
    console.log = originalLog;
    console.info = originalInfo;
    console.groupCollapsed = originalGroupCollapsed;
    console.groupEnd = originalGroupEnd;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    if (windowConsole && originalWindow) {
      windowConsole.warn = originalWindow.warn;
      windowConsole.error = originalWindow.error;
      windowConsole.log = originalWindow.log;
      windowConsole.info = originalWindow.info;
      windowConsole.groupCollapsed = originalWindow.groupCollapsed;
      windowConsole.groupEnd = originalWindow.groupEnd;
    }
  }
}

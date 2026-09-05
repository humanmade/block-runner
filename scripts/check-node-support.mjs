#!/usr/bin/env node
/**
 * Verify every non-dev package in the committed lockfile accepts each lowest
 * advertised Node release. This deliberately reads the production graph rather
 * than only checking Block Runner's direct CLI dependency.
 */
import { readFileSync } from 'node:fs';

const SUPPORTED_NODE_RANGE = '^20.19.0 || ^22.13.0 || >=24.0.0';
const SUPPORT_FLOORS = ['20.19.0', '22.13.0', '24.0.0'];
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lockfile = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

if (packageJson.engines?.node !== SUPPORTED_NODE_RANGE) {
  throw new Error(`package.json engines.node must be ${SUPPORTED_NODE_RANGE}; found ${String(packageJson.engines?.node)}.`);
}
if (lockfile.packages?.['']?.engines?.node !== SUPPORTED_NODE_RANGE) {
  throw new Error(`package-lock.json root engines.node must be ${SUPPORTED_NODE_RANGE}; found ${String(lockfile.packages?.['']?.engines?.node)}.`);
}

const failures = [];
let checked = 0;
let productionPackages = 0;
for (const [location, metadata] of Object.entries(lockfile.packages ?? {})) {
  // npm's lockfile marks a package dev only when it is not also reachable from
  // production. The root record is checked above and has no package engine to audit.
  if (!location || metadata.dev) continue;
  productionPackages += 1;
  if (typeof metadata.engines?.node !== 'string') continue;
  checked += 1;
  for (const floor of SUPPORT_FLOORS) {
    if (!satisfies(floor, metadata.engines.node)) {
      failures.push(`${location}@${metadata.version ?? 'unknown'} requires ${metadata.engines.node}, which excludes Node ${floor}`);
    }
  }
}

if (failures.length) {
  throw new Error(`Resolved production dependency engines do not support ${SUPPORTED_NODE_RANGE}:\n${failures.join('\n')}`);
}

console.log(`Resolved production dependency graph supports ${SUPPORTED_NODE_RANGE} (${productionPackages} packages, ${checked} Node engine constraints checked).`);

function satisfies(version, range) {
  return range.split('||').some((alternative) => {
    const comparators = alternative
      .trim()
      .replace(/(>=|<=|>|<|=)\s+(?=v?\d)/g, '$1')
      .split(/\s+/)
      .filter(Boolean);
    return comparators.length > 0 && comparators.every((comparator) => satisfiesComparator(version, comparator));
  });
}

function satisfiesComparator(version, comparator) {
  if (comparator === '*' || comparator.toLowerCase() === 'x') return true;
  const target = parseVersion(version);

  if (comparator.startsWith('^')) {
    const lower = parseVersion(comparator.slice(1));
    if (compare(target, lower) < 0) return false;
    const upper = lower[0] > 0 ? [lower[0] + 1, 0, 0] : lower[1] > 0 ? [0, lower[1] + 1, 0] : [0, 0, lower[2] + 1];
    return compare(target, upper) < 0;
  }

  const match = /^(>=|<=|>|<|=)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(comparator);
  if (!match) throw new Error(`Unsupported Node engine comparator in package-lock.json: ${comparator}`);
  const operator = match[1] ?? '';
  const major = Number(match[2]);
  const minor = match[3] === undefined || match[3] === 'x' || match[3] === '*' ? undefined : Number(match[3]);
  const patch = match[4] === undefined || match[4] === 'x' || match[4] === '*' ? undefined : Number(match[4]);
  const bound = [major, minor ?? 0, patch ?? 0];
  const compared = compare(target, bound);

  if (operator === '>=') return compared >= 0;
  if (operator === '<=') return compared <= 0;
  if (operator === '>') return compared > 0;
  if (operator === '<') return compared < 0;
  if (compared < 0) return false;
  if (minor === undefined) return target[0] === major;
  if (patch === undefined) return target[0] === major && target[1] === minor;
  return compared === 0;
}

function parseVersion(value) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value);
  if (!match) throw new Error(`Invalid Node version: ${value}`);
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

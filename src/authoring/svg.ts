import { JSDOM } from 'jsdom';
import postcss from 'postcss';
import { scanCssUrlReferences } from '../author/assets.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ELEMENTS = new Set(`svg g defs symbol use image path rect circle ellipse line polyline polygon
  text tspan textPath title desc linearGradient radialGradient stop clipPath mask pattern marker
  filter feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting
  feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur
  feImage feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight
  feTile feTurbulence style`.split(/\s+/));
const PRESENTATION = new Set(`alignment-baseline baseline-shift clip clip-path clip-rule color color-interpolation
  color-interpolation-filters color-rendering direction display dominant-baseline fill fill-opacity fill-rule
  filter flood-color flood-opacity font-family font-size font-size-adjust font-stretch font-style font-variant
  font-weight image-rendering isolation letter-spacing lighting-color marker-end marker-mid marker-start mask
  mix-blend-mode opacity overflow paint-order pointer-events shape-rendering stop-color stop-opacity stroke
  stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width
  text-anchor text-decoration text-rendering transform transform-origin unicode-bidi vector-effect visibility
  white-space word-spacing writing-mode`.split(/\s+/));
const ATTRIBUTES = new Set(`id class role aria-label aria-labelledby aria-describedby aria-hidden focusable tabindex
  width height x y x1 y1 x2 y2 cx cy r rx ry dx dy d points pathLength viewBox preserveAspectRatio version
  href style type media lang space gradientUnits gradientTransform spreadMethod offset fx fy fr
  clipPathUnits maskUnits maskContentUnits patternUnits patternContentUnits patternTransform
  markerUnits markerWidth markerHeight refX refY orient filterUnits primitiveUnits in in2 result
  stdDeviation mode values operator k1 k2 k3 k4 order kernelMatrix divisor bias targetX targetY edgeMode
  kernelUnitLength preserveAlpha surfaceScale diffuseConstant specularConstant specularExponent
  limitingConeAngle azimuth elevation pointsAtX pointsAtY pointsAtZ z scale xChannelSelector yChannelSelector
  amplitude exponent intercept slope tableValues radius baseFrequency numOctaves seed stitchTiles
  lengthAdjust textLength startOffset method spacing rotate`.split(/\s+/));

/** Validate, never sanitize: a successful bundled SVG retains its exact confirmed bytes. */
export function assertStaticSvg(bytes: Buffer, source: string): void {
  function fail(reason: string): never { throw new Error(`${source}: unsupported SVG: ${reason}`); }
  let xml: string;
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return fail('expected UTF-8 XML'); }
  const withoutDeclaration = xml.replace(/^\s*<\?xml\s+[^?]*\?>/, '');
  if (/<!DOCTYPE|<!ENTITY|<\?/i.test(withoutDeclaration)) fail('document types, entities, and processing instructions are not permitted');
  let dom: JSDOM;
  try { dom = new JSDOM(xml, { contentType: 'image/svg+xml' }); }
  catch { return fail('malformed XML'); }
  try {
    const document = dom.window.document;
    if (document.documentElement.localName !== 'svg' || document.documentElement.namespaceURI !== SVG_NS) fail('expected an SVG root');
    const ids = new Set<string>();
    const references: string[] = [];
    const localReference = (url: string): void => {
      if (!/^#[^\s#]+$/.test(url)) fail(`dependency ${JSON.stringify(url)} is not a local fragment; resolve it before confirmation`);
      references.push(url.slice(1));
    };
    const declaration = (property: string, value: string): void => {
      if (!PRESENTATION.has(property) || /[\\{}<>@]|expression\s*\(/i.test(value)) fail(`unsafe or unsupported style declaration ${property}`);
      for (const reference of scanCssUrlReferences(`x{${property}:${value}}`)) localReference(reference.url);
    };
    const stylesheet = (css: string, inline: boolean): void => {
      let parsed: postcss.Root;
      try { parsed = postcss.parse(inline ? `svg {${css}}` : css); }
      catch { return fail('malformed CSS'); }
      if (inline && (parsed.nodes.length !== 1 || parsed.nodes[0]?.type !== 'rule' || parsed.nodes[0].selector !== 'svg')) fail('inline CSS escaped its declaration list');
      for (const node of parsed.nodes) {
        if (node.type === 'comment') continue;
        if (node.type !== 'rule' || /[{}@]|#\{/.test(node.selector)) fail('only static style rules are supported inside SVG');
        for (const child of node.nodes ?? []) {
          if (child.type === 'comment') continue;
          if (child.type !== 'decl') fail('nested or external SVG styles are not supported');
          declaration(child.prop, child.value);
        }
      }
    };
    for (const element of document.querySelectorAll('*')) {
      if (element.namespaceURI !== SVG_NS || !ELEMENTS.has(element.localName)) fail(`element <${element.localName}> requires unsupported behavior or markup`);
      for (const attribute of element.attributes) {
        if (attribute.namespaceURI === 'http://www.w3.org/2000/xmlns/') {
          if (![SVG_NS, 'http://www.w3.org/1999/xlink'].includes(attribute.value)) fail('unsupported namespace');
          continue;
        }
        const name = attribute.localName;
        if (attribute.namespaceURI && !['http://www.w3.org/1999/xlink', 'http://www.w3.org/XML/1998/namespace'].includes(attribute.namespaceURI)) fail('unsupported attribute namespace');
        if (/^on/i.test(name) || (!ATTRIBUTES.has(name) && !PRESENTATION.has(name) && !/^data-[a-z0-9_.-]+$/.test(name))) fail(`attribute ${attribute.name} is not in the static SVG contract`);
        if (name === 'id') {
          if (!attribute.value || /\s/.test(attribute.value) || ids.has(attribute.value)) fail('empty, duplicate, or whitespace-containing id');
          ids.add(attribute.value);
        }
        if (name === 'href') localReference(attribute.value);
        else if (name === 'style') stylesheet(attribute.value, true);
        else if (PRESENTATION.has(name)) declaration(name, attribute.value);
        else if (/url\s*\(/i.test(attribute.value)) fail(`unaccounted URL in ${name}`);
      }
      if (element.localName === 'style') {
        if (element.hasAttribute('type') && element.getAttribute('type') !== 'text/css') fail('unsupported style MIME type');
        stylesheet(element.textContent ?? '', false);
      }
    }
    for (const id of references) if (!ids.has(id)) fail(`fragment #${id} has no target`);
  } finally {
    dom.window.close();
  }
}

#!/usr/bin/env bash
# Stylized view for the README demo GIF — a curated, legible summary of what
# `block-runner convert hero.html` produces (NOT the raw serializer output, which
# is intentionally compact). Block counts/structure mirror the real conversion.
set -u

P=$'\e[38;5;212m'   # wp:* block names (mauve)
D=$'\e[38;5;244m'   # tree connectors / secondary (grey)
T=$'\e[38;5;252m'   # content (soft white)
A=$'\e[38;5;180m'   # accent detail (tan)
G=$'\e[38;5;114m'   # success (green)
R=$'\e[0m'

printf '\n'
printf "  ${D}→ native, nested Gutenberg blocks${R}\n"
printf '\n'
printf "  ${P}wp:cover${R}        ${A}full-bleed section${R}\n"
printf "  ${D}└ ${P}wp:columns${R}\n"
printf "  ${D}  ├ ${P}wp:column${R}\n"
printf "  ${D}  │ ├ ${P}wp:heading${R}    ${T}hero tagline${R}\n"
printf "  ${D}  │ ├ ${P}wp:paragraph${R}  ${T}supporting copy${R}\n"
printf "  ${D}  │ └ ${P}wp:buttons${R}    ${T}call to action${R}\n"
printf "  ${D}  └ ${P}wp:column${R}\n"
printf "  ${D}    └ ${P}wp:image${R}      ${A}media #1001${R}\n"
printf '\n'
printf "  ${G}✓${R} ${T}11 blocks · all valid · 0 warnings${R}\n"
